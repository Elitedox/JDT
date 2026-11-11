fx_version 'cerulean'
game       'gta5'
lua54      'yes'
use_experimental_fxv2_oal 'yes'

name        'JDT (Jack\'s Development Tool)'
version     '1.0.0'
license     'LGPL-3.0-or-later'
author      'Jack'
description 'All-in-one FiveM MLO development tool.'

shared_scripts {
    'config.lua',
    'shared/lib.lua',
    'shared/hash.lua',
    'shared/xml.lua',
    'shared/radiopool.lua',
    'core/model.lua',
    'core/occlusion.lua',
    'core/encoders.lua',
    'core/binary.lua',
    'core/doors.lua',
    'core/audiobuild.lua',
    'core/validate.lua',
    'shared/inspect_util.lua',
}

client_scripts {
    'client/rpc.lua',
    'client/labels.lua',
    'runtime/player_core.lua',
    'client/player.lua',
    'client/custom.lua',
    'client/scanner.lua',
    'client/debugdraw.lua',
    'client/preview.lua',
    'client/editor.lua',
    'client/inspect.lua',
    'client/emitters.lua',
    'client/playertools.lua',
    'client/main.lua',
    'client/keybinds.lua',
}

server_scripts {
    'core/awc.lua',
    'server/storage.lua',
    'server/elements.lua',
    'server/sounds.lua',
    'server/export.lua',
    'server/importer.lua',
    'server/main.lua',
    'server/ytyp.js',
}

ui_page 'web/index.html'

files {
    'web/index.html',
    'web/style.css',
    'web/audio.js',
    'web/app.js',
    'web/mlox.js',
    'web/labels.js',
    'web/palette.js',
    'web/motion.js',
    'web/emitters.js',
    'web/player.js',
    'web/keybinds.js',
    'web/mlox.css',
    'web/fonts/*.woff2',
    'locales/*.json',
    'catalog/*.json',
    'samples/doors/*.ogg',
    'samples/doors/*.mp3',
    'samples/doors/*.wav',
}
