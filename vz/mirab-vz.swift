// mirab-vz: the macOS `vm` backend's launcher (Virtualization.framework).
//
// One process per microVM. It boots a Linux kernel with a copy-on-write root
// disk, an optional virtio-fs share and optional NAT, then exposes the guest's
// virtio-vsock on a unix socket using Firecracker's protocol, so the CLI's
// guest exec contract (src/isolation/session.ts) is reused unchanged:
//   host -> guest: connect to <vsock>, write "CONNECT <port>\n", read "OK <port>\n", then raw bytes;
//   guest -> host: a guest connection to host port N is relayed to the unix socket <vsock>_N
//                  (only ports named with --listen).
// The VM stops when stdin closes, on SIGTERM/SIGINT, or when the guest powers off.
//
//   mirab-vz check                 entitlement + host support; prints "ok" and exits 0
//   mirab-vz clone <src> <dst>     APFS clonefile (copy-on-write) of a file or a whole directory tree
//   mirab-vz run --kernel K --rootfs R --cmdline C --vsock SOCK --serial LOG
//               [--cpus N] [--memory MiB] [--share TAG=DIR] [--net none|nat] [--listen PORT]...
//   mirab-vz run --macos DIR --rootfs R --vsock SOCK --serial LOG [same options]
//               boots a macOS guest (Apple silicon only): DIR holds its
//               hardware-model, machine-id and aux.img (NVRAM), R its disk
//   mirab-vz macos-restore-url     the newest macOS restore image (.ipsw) this Mac can run
//   mirab-vz macos-install --ipsw P --dir DIR [--disk-gib N]
//               installs macOS from P into DIR/disk.img (sparse) and writes
//               DIR/hardware-model, DIR/machine-id and DIR/aux.img; prints
//               "progress N" lines, then "installed"
//   sudo mirab-vz macos-provision --dir DIR --agent PATH
//               before a macOS guest's first boot: on DIR/disk.img's Data
//               volume, marks setup as done (no Setup Assistant) and installs
//               the guest agent as a root LaunchDaemon on vsock 9002. Needs
//               root once per base image: launchd only runs root-owned plists.
//
// Built and ad-hoc signed with the com.apple.security.virtualization
// entitlement by scripts/build-vz-helper.sh; no developer identity needed.
import Darwin
import Foundation
import Security
import Virtualization

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

func die(_ message: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write(("mirab-vz: " + message + "\n").data(using: .utf8)!)
  exit(code)
}

func hasEntitlement() -> Bool {
  guard let task = SecTaskCreateFromSelf(nil) else { return false }
  let value = SecTaskCopyValueForEntitlement(
    task, "com.apple.security.virtualization" as CFString, nil)
  return (value as? Bool) == true
}

// MARK: byte bridging between a unix socket and a vsock connection

/// Live bridges, so the VZVirtioSocketConnection objects (which own their fd) stay alive.
final class Bridges {
  private var live: [ObjectIdentifier: AnyObject] = [:]
  private let lock = NSLock()
  func keep(_ o: AnyObject) { lock.lock(); live[ObjectIdentifier(o)] = o; lock.unlock() }
  func drop(_ o: AnyObject) { lock.lock(); live[ObjectIdentifier(o)] = nil; lock.unlock() }
}
let bridges = Bridges()

func writeAll(_ fd: Int32, _ buf: UnsafeRawPointer, _ n: Int) -> Bool {
  var off = 0
  while off < n {
    let w = write(fd, buf + off, n - off)
    if w < 0 { if errno == EINTR { continue }; return false }
    off += w
  }
  return true
}

/// Copy a -> b until EOF or error, then half-close b.
func pump(_ a: Int32, _ b: Int32) {
  let size = 64 * 1024
  let buf = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 1)
  defer { buf.deallocate() }
  while true {
    let r = read(a, buf, size)
    if r < 0 && errno == EINTR { continue }
    if r <= 0 || !writeAll(b, buf, r) { break }
  }
  shutdown(b, SHUT_WR)
}

/// Runs both directions; when both have ended, closes the unix fd and the vsock connection.
func bridge(_ unixFd: Int32, _ conn: VZVirtioSocketConnection) {
  bridges.keep(conn)
  let vfd = conn.fileDescriptor
  let group = DispatchGroup()
  for (a, b) in [(unixFd, vfd), (vfd, unixFd)] {
    group.enter()
    Thread.detachNewThread { pump(a, b); group.leave() }
  }
  group.notify(queue: .main) {
    close(unixFd)
    conn.close()
    bridges.drop(conn)
  }
}

// MARK: unix sockets

func unixAddress(_ path: String) -> sockaddr_un {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  if bytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { die("socket path too long: \(path)") }
  withUnsafeMutableBytes(of: &addr.sun_path) { dst in
    for (i, c) in bytes.enumerated() { dst[i] = c }
  }
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  return addr
}

func unixListen(_ path: String) -> Int32 {
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = unixAddress(path)
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if ok != 0 || listen(fd, 64) != 0 { die("listen \(path): \(String(cString: strerror(errno)))") }
  chmod(path, 0o600)
  return fd
}

func unixConnect(_ path: String) -> Int32? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = unixAddress(path)
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if ok != 0 { close(fd); return nil }
  return fd
}

/// Reads "CONNECT <port>\n" byte by byte so no payload byte is consumed.
func readConnect(_ fd: Int32) -> UInt32? {
  var line = [UInt8]()
  var c: UInt8 = 0
  while line.count < 64 {
    if read(fd, &c, 1) != 1 { return nil }
    if c == 10 { break }
    line.append(c)
  }
  let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespaces)
  guard text.hasPrefix("CONNECT "), let port = UInt32(text.dropFirst(8)) else { return nil }
  return port
}

// MARK: the VM

struct Options {
  var kernel = "", rootfs = "", cmdline = "", vsock = "", serial = "", macos = ""
  var cpus = 2, memoryMiB: UInt64 = 1024, net = "none"
  var share: (tag: String, dir: String)?
  var listen: [UInt32] = []
}

func parse(_ args: [String]) -> Options {
  var o = Options()
  var i = 0
  func value() -> String {
    i += 1
    if i >= args.count { die("\(args[i - 1]) needs a value") }
    return args[i]
  }
  while i < args.count {
    switch args[i] {
    case "--kernel": o.kernel = value()
    case "--macos": o.macos = value()
    case "--rootfs": o.rootfs = value()
    case "--cmdline": o.cmdline = value()
    case "--vsock": o.vsock = value()
    case "--serial": o.serial = value()
    case "--cpus": o.cpus = Int(value()) ?? 0
    case "--memory": o.memoryMiB = UInt64(value()) ?? 0
    case "--net": o.net = value()
    case "--listen":
      guard let p = UInt32(value()) else { die("--listen needs a port number") }
      o.listen.append(p)
    case "--share":
      let v = value()
      guard let eq = v.firstIndex(of: "=") else { die("--share needs TAG=DIR") }
      o.share = (String(v[..<eq]), String(v[v.index(after: eq)...]))
    default: die("unknown option \(args[i])")
    }
    i += 1
  }
  for (name, v) in [("--rootfs", o.rootfs), ("--vsock", o.vsock), ("--serial", o.serial)]
  where v.isEmpty { die("\(name) is required") }
  if o.macos.isEmpty && o.kernel.isEmpty { die("--kernel (Linux) or --macos (macOS) is required") }
  if o.net != "none" && o.net != "nat" { die("--net is none or nat") }
  return o
}

final class Machine: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
  let o: Options
  var vm: VZVirtualMachine!
  var device: VZVirtioSocketDevice!
  let listener = VZVirtioSocketListener()
  var stopping = false

  init(_ o: Options) { self.o = o }

  func configuration() throws -> VZVirtualMachineConfiguration {
    let c = VZVirtualMachineConfiguration()
    if o.macos.isEmpty {
      let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: o.kernel))
      boot.commandLine = o.cmdline
      c.bootLoader = boot
    } else {
      #if arch(arm64)
        c.platform = try macPlatform(o.macos, create: nil)
        c.bootLoader = VZMacOSBootLoader()
        // macOS needs a display even with nobody watching.
        c.graphicsDevices = [macDisplay()]
      #else
        throw NSError(domain: "mirab-vz", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS guests need Apple silicon"])
      #endif
    }
    c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                     min(o.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    c.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, o.memoryMiB << 20)
    // The root disk is the caller's per-VM clone; the base image is never attached.
    let disk = try VZDiskImageStorageDeviceAttachment(
      url: URL(fileURLWithPath: o.rootfs), readOnly: false)
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
    FileManager.default.createFile(atPath: o.serial, contents: nil, attributes: [.posixPermissions: 0o600])
    guard let out = FileHandle(forWritingAtPath: o.serial),
      let input = FileHandle(forReadingAtPath: "/dev/null")
    else { throw NSError(domain: "mirab-vz", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot open \(o.serial)"]) }
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: input, fileHandleForWriting: out)
    c.serialPorts = [console]
    c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    if let s = o.share {
      let fs = VZVirtioFileSystemDeviceConfiguration(tag: s.tag)
      fs.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: s.dir), readOnly: false))
      c.directorySharingDevices = [fs]
    }
    if o.net == "nat" {
      let n = VZVirtioNetworkDeviceConfiguration()
      n.attachment = VZNATNetworkDeviceAttachment()
      n.macAddress = VZMACAddress.randomLocallyAdministered()
      c.networkDevices = [n]
    }
    try c.validate()
    return c
  }

  func start() {
    let t0 = Date()
    do {
      vm = VZVirtualMachine(configuration: try configuration())
    } catch { die("configuration: \(error.localizedDescription)") }
    vm.delegate = self
    device = vm.socketDevices.first as? VZVirtioSocketDevice
    listener.delegate = self
    for p in o.listen { device.setSocketListener(listener, forPort: p) }
    let server = unixListen(o.vsock)
    Thread.detachNewThread { self.accept(server) }
    vm.start { result in
      switch result {
      case .success: print("started \(Int(Date().timeIntervalSince(t0) * 1000))")
      case .failure(let e): die("start: \(e.localizedDescription)", 1)
      }
    }
  }

  func accept(_ server: Int32) {
    while true {
      let fd = Darwin.accept(server, nil, nil)
      if fd < 0 { if errno == EINTR { continue }; return }
      Thread.detachNewThread {
        guard let port = readConnect(fd) else { close(fd); return }
        DispatchQueue.main.async {
          self.device.connect(toPort: port) { result in
            switch result {
            case .success(let conn):
              let ok = Array("OK \(port)\n".utf8)
              if writeAll(fd, ok, ok.count) { bridge(fd, conn) } else { close(fd); conn.close() }
            case .failure:
              close(fd)
            }
          }
        }
      }
    }
  }

  // Guest -> host: relay to <vsock>_<port> when something listens there.
  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                from socketDevice: VZVirtioSocketDevice) -> Bool {
    guard let fd = unixConnect("\(o.vsock)_\(connection.destinationPort)") else { return false }
    bridge(fd, connection)
    return true
  }

  func stop(_ code: Int32) {
    if stopping { return }
    stopping = true
    unlink(o.vsock)
    if vm.canStop {
      vm.stop { _ in exit(code) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(code) }
    } else { exit(code) }
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) { unlink(o.vsock); exit(0) }
  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    die("stopped: \(error.localizedDescription)", 1)
  }
}

// MARK: macOS guests (Apple silicon)

#if arch(arm64)
  func fail(_ m: String) -> NSError { NSError(domain: "mirab-vz", code: 1, userInfo: [NSLocalizedDescriptionKey: m]) }

  /// The platform a macOS guest needs: its hardware model, a machine identifier
  /// and its NVRAM. `create` makes them for a fresh install from the restore
  /// image's model; otherwise they're read from DIR.
  func macPlatform(_ dir: String, create model: VZMacHardwareModel?) throws -> VZMacPlatformConfiguration {
    let d = URL(fileURLWithPath: dir)
    let p = VZMacPlatformConfiguration()
    if let model = model {
      try model.dataRepresentation.write(to: d.appendingPathComponent("hardware-model"))
      let id = VZMacMachineIdentifier()
      try id.dataRepresentation.write(to: d.appendingPathComponent("machine-id"))
      p.hardwareModel = model
      p.machineIdentifier = id
      p.auxiliaryStorage = try VZMacAuxiliaryStorage(
        creatingStorageAt: d.appendingPathComponent("aux.img"), hardwareModel: model, options: [.allowOverwrite])
    } else {
      guard let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: d.appendingPathComponent("hardware-model"))),
        model.isSupported
      else { throw fail("\(dir)/hardware-model is missing or not supported on this Mac") }
      guard let id = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: d.appendingPathComponent("machine-id")))
      else { throw fail("\(dir)/machine-id is missing or invalid") }
      p.hardwareModel = model
      p.machineIdentifier = id
      p.auxiliaryStorage = VZMacAuxiliaryStorage(url: d.appendingPathComponent("aux.img"))
    }
    return p
  }

  func macDisplay() -> VZMacGraphicsDeviceConfiguration {
    let g = VZMacGraphicsDeviceConfiguration()
    g.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1280, heightInPixels: 800, pixelsPerInch: 80)]
    return g
  }

  /// Installs macOS from an .ipsw into DIR/disk.img (sparse, `gib` GiB).
  final class Installer: NSObject {
    var vm: VZVirtualMachine!
    var installer: VZMacOSInstaller!
    var watch: NSKeyValueObservation?

    func run(ipsw: String, dir: String, gib: UInt64) {
      VZMacOSRestoreImage.load(from: URL(fileURLWithPath: ipsw)) { result in
        DispatchQueue.main.async {
          do {
            let image = try result.get()
            guard let req = image.mostFeaturefulSupportedConfiguration, req.hardwareModel.isSupported
            else { throw fail("this Mac can't run the macOS in \(ipsw)") }
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let disk = URL(fileURLWithPath: dir).appendingPathComponent("disk.img")
            FileManager.default.createFile(atPath: disk.path, contents: nil)
            let h = try FileHandle(forWritingTo: disk)
            try h.truncate(atOffset: gib << 30)
            try h.close()
            let c = VZVirtualMachineConfiguration()
            c.platform = try macPlatform(dir, create: req.hardwareModel)
            c.bootLoader = VZMacOSBootLoader()
            c.cpuCount = max(req.minimumSupportedCPUCount, 2)
            c.memorySize = max(req.minimumSupportedMemorySize, 4 << 30)
            c.graphicsDevices = [macDisplay()]
            c.storageDevices = [VZVirtioBlockDeviceConfiguration(
              attachment: try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false))]
            let n = VZVirtioNetworkDeviceConfiguration()
            n.attachment = VZNATNetworkDeviceAttachment()
            c.networkDevices = [n]
            try c.validate()
            self.vm = VZVirtualMachine(configuration: c)
            self.installer = VZMacOSInstaller(virtualMachine: self.vm, restoringFromImageAt: URL(fileURLWithPath: ipsw))
            var last = -1
            self.watch = self.installer.progress.observe(\.fractionCompleted) { p, _ in
              let pct = Int(p.fractionCompleted * 100)
              if pct != last { last = pct; print("progress \(pct)") }
            }
            self.installer.install { r in
              switch r {
              case .success: print("installed"); exit(0)
              case .failure(let e): die("install: \(e.localizedDescription)", 1)
              }
            }
          } catch { die("install: \(error.localizedDescription)", 1) }
        }
      }
    }
  }
#endif

// MARK: provisioning a macOS disk before its first boot (root)

@discardableResult
func run(_ path: String, _ args: [String]) -> Data {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.standardError
  do { try p.run() } catch { die("\(path): \(error.localizedDescription)", 1) }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  if p.terminationStatus != 0 { die("\(path) \(args.joined(separator: " ")) exited \(p.terminationStatus)", 1) }
  return data
}

func plist(_ d: Data) -> [String: Any] {
  (try? PropertyListSerialization.propertyList(from: d, format: nil)) as? [String: Any] ?? [:]
}

/// The agent's LaunchDaemon: root, at boot, kept alive, listening on vsock 9002.
let agentPlist = """
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>gg.mirab.guest-agent</string>
    <key>ProgramArguments</key><array>
      <string>/usr/local/libexec/mirab-guest-agent</string><string>--vsock</string><string>9002</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardErrorPath</key><string>/var/log/mirab-guest-agent.log</string>
  </dict></plist>

  """

func provision(dir: String, agent: String) {
  if getuid() != 0 { die("macos-provision needs root (sudo), once per base image", 1) }
  let disk = URL(fileURLWithPath: dir).appendingPathComponent("disk.img").path
  guard FileManager.default.fileExists(atPath: disk) else { die("no \(disk) (run macos-install first)", 1) }
  guard let agentBytes = FileManager.default.contents(atPath: agent) else { die("cannot read \(agent)", 1) }
  let attached = plist(run("/usr/bin/hdiutil", ["attach", "-nomount", "-imagekey", "diskimage-class=CRawDiskImage", "-plist", disk]))
  let entities = attached["system-entities"] as? [[String: Any]] ?? []
  let devs = entities.compactMap { ($0["dev-entry"] as? String)?.replacingOccurrences(of: "/dev/", with: "") }
  // The image's own disk carries the partition map; attaching also creates
  // synthesized APFS container disks, which detach with it.
  let partitioned = entities.first { ($0["content-hint"] as? String) == "GUID_partition_scheme" }
  guard let whole = (partitioned?["dev-entry"] as? String)?.replacingOccurrences(of: "/dev/", with: "")
    ?? devs.min(by: { $0.count < $1.count })
  else { die("hdiutil attached nothing", 1) }
  defer { run("/usr/bin/hdiutil", ["detach", "/dev/\(whole)"]) }
  // The Data volume of the APFS container that lives on the attached image.
  let containers = plist(run("/usr/sbin/diskutil", ["apfs", "list", "-plist"]))["Containers"] as? [[String: Any]] ?? []
  var data: String?
  for c in containers {
    let stores = (c["PhysicalStores"] as? [[String: Any]] ?? []).compactMap { $0["DeviceIdentifier"] as? String }
    guard stores.contains(where: { devs.contains($0) }) else { continue }
    for v in c["Volumes"] as? [[String: Any]] ?? [] where (v["Roles"] as? [String] ?? []).contains("Data") {
      data = v["DeviceIdentifier"] as? String
    }
  }
  guard let volume = data else { die("no APFS Data volume on \(disk): is macOS installed there?", 1) }
  let mount = "/private/var/tmp/mirab-macos-provision-\(getpid())"
  try? FileManager.default.createDirectory(atPath: mount, withIntermediateDirectories: true)
  run("/usr/sbin/diskutil", ["mount", "-mountPoint", mount, volume])
  defer {
    run("/usr/sbin/diskutil", ["unmount", mount])
    try? FileManager.default.removeItem(atPath: mount)
  }
  run("/usr/sbin/diskutil", ["enableOwnership", mount])
  let fm = FileManager.default
  let root: [FileAttributeKey: Any] = [.ownerAccountID: 0, .groupOwnerAccountID: 0]
  func dirs(_ path: String) {
    do { try fm.createDirectory(atPath: mount + path, withIntermediateDirectories: true,
                                attributes: root.merging([.posixPermissions: 0o755]) { $1 }) }
    catch { die("mkdir \(path): \(error.localizedDescription)", 1) }
  }
  func file(_ path: String, _ bytes: Data, _ mode: Int) {
    if !fm.createFile(atPath: mount + path, contents: bytes, attributes: root.merging([.posixPermissions: mode]) { $1 }) {
      die("write \(path) failed", 1)
    }
  }
  dirs("/private/var/db")
  file("/private/var/db/.AppleSetupDone", Data(), 0o644)
  dirs("/usr/local/libexec")
  file("/usr/local/libexec/mirab-guest-agent", agentBytes, 0o755)
  dirs("/Library/LaunchDaemons")
  file("/Library/LaunchDaemons/gg.mirab.guest-agent.plist", agentPlist.data(using: .utf8)!, 0o644)
  // A marker the unprivileged side can check, owned by whoever ran sudo.
  let marker = URL(fileURLWithPath: dir).appendingPathComponent("provisioned").path
  fm.createFile(atPath: marker, contents: "agent \(agentBytes.count) bytes\n".data(using: .utf8))
  if let u = ProcessInfo.processInfo.environment["SUDO_UID"].flatMap(UInt32.init),
     let g = ProcessInfo.processInfo.environment["SUDO_GID"].flatMap(UInt32.init) { chown(marker, u, g) }
  print("provisioned \(volume): setup done, guest agent as gg.mirab.guest-agent on vsock 9002")
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "check":
  if !hasEntitlement() { die("missing com.apple.security.virtualization entitlement (run scripts/build-vz-helper.sh)", 1) }
  if !VZVirtualMachine.isSupported { die("Virtualization.framework is not supported on this host", 1) }
  print("ok")
  exit(0)
case "clone":
  guard args.count == 3 else { die("usage: mirab-vz clone <src> <dst>") }
  if clonefile(args[1], args[2], UInt32(CLONE_NOFOLLOW)) != 0 {
    die("clone \(args[1]): \(String(cString: strerror(errno)))", 1)
  }
  exit(0)
case "macos-restore-url":
  #if arch(arm64)
    VZMacOSRestoreImage.fetchLatestSupported { result in
      switch result {
      case .success(let image): print(image.url.absoluteString); exit(0)
      case .failure(let e): die("restore image: \(e.localizedDescription)", 1)
      }
    }
    dispatchMain()
  #else
    die("macOS guests need Apple silicon", 1)
  #endif
case "macos-install":
  #if arch(arm64)
    var ipsw = "", dir = "", gib: UInt64 = 64
    var i = 1
    while i < args.count {
      let v = i + 1 < args.count ? args[i + 1] : ""
      switch args[i] {
      case "--ipsw": ipsw = v
      case "--dir": dir = v
      case "--disk-gib": gib = UInt64(v) ?? 0
      default: die("unknown option \(args[i])")
      }
      i += 2
    }
    if ipsw.isEmpty || dir.isEmpty || gib < 32 { die("usage: mirab-vz macos-install --ipsw P --dir DIR [--disk-gib N >= 32]") }
    let installer = Installer()
    DispatchQueue.main.async { installer.run(ipsw: ipsw, dir: dir, gib: gib) }
    withExtendedLifetime(installer) { dispatchMain() }
  #else
    die("macOS guests need Apple silicon", 1)
  #endif
case "macos-provision":
  var dir = "", agent = ""
  var j = 1
  while j < args.count {
    let v = j + 1 < args.count ? args[j + 1] : ""
    switch args[j] {
    case "--dir": dir = v
    case "--agent": agent = v
    default: die("unknown option \(args[j])")
    }
    j += 2
  }
  if dir.isEmpty || agent.isEmpty { die("usage: sudo mirab-vz macos-provision --dir DIR --agent PATH") }
  provision(dir: dir, agent: agent)
  exit(0)
case "run":
  let machine = Machine(parse(Array(args.dropFirst())))
  var sources: [DispatchSourceSignal] = []
  for s in [SIGTERM, SIGINT, SIGHUP] {
    signal(s, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
    src.setEventHandler { machine.stop(0) }
    src.resume()
    sources.append(src)
  }
  // The CLI holds our stdin: when it goes away, so does the VM.
  Thread.detachNewThread {
    var b: UInt8 = 0
    while read(0, &b, 1) > 0 {}
    DispatchQueue.main.async { machine.stop(0) }
  }
  DispatchQueue.main.async { machine.start() }
  withExtendedLifetime(sources) { dispatchMain() }
default:
  die("usage: mirab-vz check | clone <src> <dst> | run (--kernel K --cmdline C | --macos DIR) --rootfs R --vsock SOCK --serial LOG [...] | macos-restore-url | macos-install --ipsw P --dir DIR [--disk-gib N]")
}
