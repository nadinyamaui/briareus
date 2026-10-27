"""Briareus Linux resource collector. Python 3 standard library, no root or daemon.

Counters follow https://docs.kernel.org/filesystems/proc.html. Briareus computes
CPU and network rates between samples; counters are reset on each boot.
"""
import json
import os
import re


def read(path):
    with open(path, encoding="utf-8") as source:
        return source.read()


def unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


def collect():
    stat = read("/proc/stat").splitlines()
    # Guest time is already included in user/nice; only the first eight count.
    cpu = [int(value) for value in stat[0].split()[1:9]]
    memory = {}
    for line in read("/proc/meminfo").splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.split()[0]) * 1024
    total = memory["MemTotal"]
    available = memory.get("MemAvailable", sum(memory.get(key, 0) for key in
                           ("MemFree", "Buffers", "Cached", "SReclaimable"))
                           - memory.get("Shmem", 0))
    available = max(0, min(total, available))
    network = []
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, values = line.split(":", 1)
        name = name.strip()
        if name == "lo":
            continue
        values = values.split()
        network.append({"name": name, "rxBytes": int(values[0]), "txBytes": int(values[8])})
    disks = []
    seen = set()
    local_types = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs",
                   "vfat", "exfat", "ntfs", "ntfs3", "overlay", "tmpfs"}
    for line in read("/proc/self/mountinfo").splitlines():
        before, after = line.split(" - ", 1)
        fields, filesystem = before.split(), after.split()
        mount, device = unescape(fields[4]), unescape(filesystem[1])
        key = (fields[2], fields[3])
        # Avoid network/automount filesystems: statvfs can block on a dead peer.
        if filesystem[0] not in local_types or key in seen:
            continue
        if any(mount == path or mount.startswith(path + "/") for path in ("/proc", "/sys")):
            continue
        if (mount == "/dev" or mount.startswith("/dev/")) and mount != "/dev/shm":
            continue
        if not os.path.isdir(mount):
            continue
        try:
            usage = os.statvfs(mount)
        except OSError:
            continue
        if not usage.f_blocks:
            continue
        seen.add(key)
        size = usage.f_blocks * usage.f_frsize
        used = (usage.f_blocks - usage.f_bfree) * usage.f_frsize
        free = max(0, usage.f_bavail * usage.f_frsize)
        disks.append({"mount": mount, "device": device, "filesystem": filesystem[0],
                      "totalBytes": size, "usedBytes": used, "availableBytes": free,
                      "usedPercent": round(100 * used / (used + free), 2) if used + free else 0})
    return {"bootId": read("/proc/sys/kernel/random/boot_id").strip(),
            "uptimeSeconds": float(read("/proc/uptime").split()[0]),
            "cpu": {"counters": cpu, "cores": sum(line.startswith("cpu") and
                    line[3:4].isdigit() for line in stat), "loadAverage": list(os.getloadavg())},
            "memory": {"totalBytes": total, "availableBytes": available,
                       "usedBytes": total - available, "usedPercent": round(100 * (total - available) / total, 2),
                       "swapTotalBytes": memory.get("SwapTotal", 0),
                       "swapUsedBytes": memory.get("SwapTotal", 0) - memory.get("SwapFree", 0)},
            "disks": disks, "network": network}


if __name__ == "__main__":
    print(json.dumps(collect(), separators=(",", ":")))
