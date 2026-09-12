"""Run through Blender MCP in GUI Blender; supply SVG_SETUP_OUTPUT externally.

Creates a separate setup scene without deleting existing scenes/objects.
This native Grease Pencil monkey is an export fixture, not an avatar draft.
"""
import bpy
import json
import math

window = bpy.context.window_manager.windows[0]
scene = bpy.data.scenes.new('STRKWORLD SVG Setup Check')
window.scene = scene
scene.render.resolution_x = 64
scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.fps = 8
scene.frame_set(1)

camera_data = bpy.data.cameras.new('SVG Check Camera')
camera = bpy.data.objects.new('SVG Check Camera', camera_data)
scene.collection.objects.link(camera)
camera.location = (0, -8, 0)
camera.rotation_euler = (math.pi / 2, 0, 0)
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 4
scene.camera = camera

area = max([a for a in window.screen.areas if a.type == 'VIEW_3D'], key=lambda a: a.width * a.height)
region = next(r for r in area.regions if r.type == 'WINDOW')
area.spaces.active.camera = camera
area.spaces.active.region_3d.view_perspective = 'CAMERA'
area.spaces.active.region_3d.view_camera_zoom = 0

with bpy.context.temp_override(window=window, area=area, region=region):
    bpy.ops.object.grease_pencil_add(type='MONKEY', location=(0, 0, 0))
    fixture = bpy.context.object
    fixture.name = 'SVG Export Fixture - not avatar art'
    bpy.context.view_layer.update()
    result = bpy.ops.wm.grease_pencil_export_svg(
        filepath=SVG_SETUP_OUTPUT + '/blender-svg-smoke.svg',
        check_existing=False,
        selected_object_type='ACTIVE',
        frame_mode='ACTIVE',
        use_fill=True,
        stroke_sample=0.0,
        use_uniform_width=False,
        use_clip_camera=True,
    )
    assert result == {'FINISHED'}, result
    bpy.ops.wm.save_as_mainfile(filepath=SVG_SETUP_OUTPUT + '/blender-svg-setup-check.blend')
    print(json.dumps({
        'result': sorted(result),
        'blender': bpy.app.version_string,
        'scene': scene.name,
        'fixture': fixture.name,
        'fixture_type': fixture.type,
        'camera_type': camera_data.type,
        'render_size': [scene.render.resolution_x, scene.render.resolution_y],
        'svg': SVG_SETUP_OUTPUT + '/blender-svg-smoke.svg',
        'blend': bpy.data.filepath,
    }))
