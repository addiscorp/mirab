#!/bin/sh
# Network for mirab microVMs and containers: internet egress allowed; the host,
# the LAN (10/8, 172.16/12, 192.168/16), tailnet (100.64/10), link-local incl.
# the cloud metadata address (169.254/16) and other VMs denied. Idempotent.
#
#   sudo scripts/vm-network-setup.sh [up|down] [--slots N] [--persist]
#
# Creates: bridge mirabbr0 (172.31.250.1/24) with N tap devices mirabtap0..N-1
# owned by $SUDO_USER (isolated from each other), a docker network
# mirab-egress on bridge mirabbr1 (172.31.249.0/24) when docker is installed, and
# the nftables table `inet mirab_vm`. The old `inet gild` table is not touched.
set -eu

action=up slots=16 persist=0 print_unit=0
installed=/usr/local/libexec/mirab-vm-network-setup
for a in "$@"; do
  case $a in
    up|down) action=$a ;;
    --persist) persist=1 ;;
    --print-unit) print_unit=1 ;;
    --slots) ;;
    [0-9]*) slots=$a ;;
    *) echo "usage: $0 [up|down] [--slots N] [--persist]" >&2; exit 2 ;;
  esac
done
unit() {
  # Root runs only the root-owned installed copy, never a file in a user-writable checkout.
  cat <<UNIT
[Unit]
Description=mirab microVM network
After=network-online.target docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
Environment=SUDO_USER=${user:-runner}
ExecStart=$installed up --slots $slots
[Install]
WantedBy=multi-user.target
UNIT
}
if [ "$print_unit" = 1 ]; then user=${SUDO_USER:-runner}; unit; exit 0; fi
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
user=${SUDO_USER:-}
[ -n "$user" ] && [ "$user" != root ] || { echo "run via sudo from the runner user's account (SUDO_USER is unset)" >&2; exit 1; }

teardown() {
  nft delete table inet mirab_vm 2>/dev/null || true
  if command -v iptables >/dev/null 2>&1; then
    iptables -D DOCKER-USER -i mirabbr0 -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -o mirabbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  fi
  i=0
  while [ $i -lt 256 ]; do
    ip link del "mirabtap$i" 2>/dev/null || break
    i=$((i + 1))
  done
  ip link del mirabbr0 2>/dev/null || true
  if command -v docker >/dev/null 2>&1; then docker network rm mirab-egress >/dev/null 2>&1 || true; fi
}

if [ "$action" = down ]; then
  teardown
  rm -f /etc/sysctl.d/90-mirab-vm.conf /etc/systemd/system/mirab-vm-network.service "$installed"
  echo "mirab vm network removed"
  exit 0
fi

sysctl -qw net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-mirab-vm.conf

# Rules first: if they fail (set -e) no bridge or tap exists to leak through.
nft delete table inet mirab_vm 2>/dev/null || true
nft -f - <<'RULES'
table inet mirab_vm {
  set denied4 {
    type ipv4_addr
    flags interval
    elements = {
      0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
      172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4
    }
  }
  # Guests never reach the host itself (no DNS, no services, no ICMP).
  chain input {
    type filter hook input priority -10; policy accept;
    iifname { "mirabbr0", "mirabbr1" } drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname { "mirabbr0", "mirabbr1" } meta nfproto ipv6 drop
    iifname { "mirabbr0", "mirabbr1" } ip daddr @denied4 drop
    oifname { "mirabbr0", "mirabbr1" } ct state established,related accept
    oifname { "mirabbr0", "mirabbr1" } drop
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    iifname { "mirabbr0", "mirabbr1" } oifname != { "mirabbr0", "mirabbr1" } masquerade
  }
}
RULES

ip link show mirabbr0 >/dev/null 2>&1 || ip link add mirabbr0 type bridge
ip addr replace 172.31.250.1/24 dev mirabbr0
ip link set mirabbr0 up

i=0
while [ $i -lt "$slots" ]; do
  t=mirabtap$i
  ip link show "$t" >/dev/null 2>&1 || ip tuntap add dev "$t" mode tap user "$user"
  ip link set "$t" master mirabbr0
  bridge link set dev "$t" isolated on 2>/dev/null || echo "warning: kernel lacks bridge port isolation for $t" >&2
  ip link set "$t" up
  i=$((i + 1))
done

if command -v docker >/dev/null 2>&1 && ! docker network inspect mirab-egress >/dev/null 2>&1; then
  docker network create --driver bridge --subnet 172.31.249.0/24 \
    -o com.docker.network.bridge.name=mirabbr1 \
    -o com.docker.network.bridge.enable_icc=false mirab-egress >/dev/null
fi


# Docker sets the iptables FORWARD policy to DROP and only accepts its own bridges,
# so the VM bridge needs an accept in DOCKER-USER (our nft drops above still win:
# they run first and a drop is final).
if command -v iptables >/dev/null 2>&1 && iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  iptables -C DOCKER-USER -i mirabbr0 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i mirabbr0 -j ACCEPT
  iptables -C DOCKER-USER -o mirabbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
    iptables -I DOCKER-USER -o mirabbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
fi

if [ "$persist" = 1 ]; then
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -o root -g root -m 0755 "$0" "$installed"
  unit > /etc/systemd/system/mirab-vm-network.service
  systemctl daemon-reload
  systemctl enable mirab-vm-network.service >/dev/null
fi
echo "mirab vm network ready: $slots tap slots owned by $user"
