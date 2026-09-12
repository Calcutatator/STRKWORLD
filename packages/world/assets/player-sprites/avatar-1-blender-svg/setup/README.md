# Verified Blender setup

Installed for James on 2026-09-12:

- Blender **5.2.1 LTS**, Apple Silicon, via the Homebrew cask using Blender's
  official release download. App: `/Applications/Blender.app`.
- `blender-mcp` **1.9.1** in
  `/Users/james.wilcock/.codex/tools/blender-mcp/venv/`, with Python 3.11.15.
- Matching add-on at
  `/Users/james.wilcock/Library/Application Support/Blender/5.2/scripts/addons/blender_mcp.py`.
  Add-on internal version is 1.6; protocol is 5. These are distinct from the
  Python distribution's version.
- Codex server `blender` uses the environment's absolute `bin/blender-mcp`
  command, `BLENDER_HOST=127.0.0.1`, `BLENDER_PORT=9876`,
  `DISABLE_TELEMETRY=true` and `BLENDER_MCP_DISABLE_TELEMETRY=1`.
  Blender's saved `telemetry_consent` preference is also false.

Open Blender normally; the enabled add-on starts the localhost connection.
If it is stopped manually, use the 3D View sidebar's **MCP for Blender** panel
to start it again. Codex needs one restart after this initial configuration
addition; do not infer current-task tool availability from a config entry.

The setup directory holds a native Grease Pencil monkey fixture, its `.blend`,
the exported SVG, a 64×64 raster and an enlarged preview. This is a tool/export
probe, not new avatar artwork. The default scene was retained; the fixture was
created in a separate `STRKWORLD SVG Setup Check` scene.

[`setup-report.json`](setup-report.json) records checksums, live MCP handshake,
scene readback, vector counts and raster checks. The SVG has 28 actual paths,
no bitmap embeds and a 64×64 viewport. The raster was visually inspected.
Its antialiased edges do not establish the final sprite's binary-alpha gate.

The generic local MCP verification helper is
`/Users/james.wilcock/.codex/tools/blender-mcp/mcp_client.py`.
With the dedicated environment's Python, it can list tools, call a named tool
with a JSON argument file, or run a supplied Blender Python script through
`execute_blender_code`. [`svg_export_probe.py`](svg_export_probe.py) accepts
the existing absolute output directory in `SVG_SETUP_OUTPUT`; the helper's
optional fourth argument supplies it. Re-running creates another setup scene
and exports to the chosen directory; use a new directory to preserve evidence.

The private Codex config backup and raw setup logs remain under
`/Users/james.wilcock/.codex/tools/blender-mcp/setup-20260912/`. They are not
committed. Existing MCP entries were preserved; the Codex CLI normalized one
empty `node_repl.args` array to an omitted equivalent default.

Sources: [Blender MCP upstream](https://github.com/ahujasid/blender-mcp),
[pinned package](https://pypi.org/project/blender-mcp/1.9.1/),
[Blender SVG exporter API](https://docs.blender.org/api/5.2/bpy.ops.wm.html).
