
## vmlab — cross-platform build / test orchestration

This repo uses [vmlab](https://github.com/edihasaj/vmlab) to drive flows across
local hosts, VMs, mobile devices, and browsers. Everything is YAML; the schema
is self-describing — agents can introspect without leaving the shell.

Discover:

```sh
vmlab transport ls            # every transport (ssh, ssh-windows, adb, idb, parallels-guest, …)
vmlab provider ls             # every VM provider (parallels, hetzner, aws, azure, gcp, tart)
vmlab schema target           # JSON schema for target YAML
vmlab schema flow             # JSON schema for flow YAML
vmlab schema instance         # JSON schema for instance YAML
vmlab doctor                  # confirms binaries + target reachability
```

Layout:

- `flows/*.yaml` — what to run (sync / run / assert / exec / artifact / when).
- `.vmlab/targets/*.yaml` — repo-level targets (a Linux box, a Pixel, an iOS sim).
- `.vmlab/instances/*.yaml` — repo-level VM/cloud instances managed by vmlab.
- `~/.vmlab/{targets,instances}/` — user-level versions; repo files override.
- `example.*.yaml` next to each — fully-commented templates per transport / provider.

Common moves:

```sh
vmlab run @linux flows/install.yaml            # against every @linux target
vmlab with my-vm -- vmlab run my-vm flows/x.yaml # bring up VM, run, restore
vmlab matrix run @ci flows/build.yaml          # cross-OS table output, ND-JSON rows
vmlab watch @ci flows/build.yaml --src .       # re-run on save
```

MCP for agents: `vmlab serve --mcp --allow-write` exposes targets, doctor,
evidence, run, web, gui as MCP tools.

