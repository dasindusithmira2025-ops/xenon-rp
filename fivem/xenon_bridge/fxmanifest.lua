--[[
  xenon_bridge

  The only Lua in this repository, and it exists because FiveM requires a
  manifest in Lua and accepts nothing else. There is no application logic here:
  every decision the bridge makes lives in the compiled TypeScript under
  dist/, and everything it decides is delegated to Xenon over a signed HTTP
  call.

  Install:
    1. Copy this folder into your server's resources directory.
    2. Build it once:  pnpm --filter @xenon/fivem-bridge build
    3. Add to server.cfg:

         set xenon_endpoint "https://your-xenon-site"
         set xenon_secret   "the same value as FIVEM_BRIDGE_SECRET"
         set xenon_slug     "xenon-main"
         ensure xenon_bridge

  `xenon_secret` must never be a convar the client can read: use `set`, not
  `setr`. See docs/FIVEM_SETUP.md.
]]

fx_version 'cerulean'
game 'gta5'

name 'xenon_bridge'
description 'Connects a FiveM server to the XenonRP platform: whitelist gate and account linking.'
author 'XenonRP'
version '1.0.0'

-- Compiled from src/. Do not edit dist/ by hand.
server_scripts { 'dist/server.js' }

-- The bridge listens for signed requests from Xenon (status, whitelist push,
-- presence) on the server's HTTP port.
server_exports { 'isWhitelisted' }

dependencies { '/server:7290' }
