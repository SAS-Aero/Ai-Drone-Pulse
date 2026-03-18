#!/usr/bin/env node
// Launcher that ensures ELECTRON_RUN_AS_NODE is unset before starting Electron.
// This prevents Electron from running in "node-only" mode, restoring the browser APIs.
'use strict'
const { spawn } = require('child_process')
const path = require('path')

const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = path.join(__dirname, '..')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.ELECTRON_IS_DEV = '1'

const child = spawn(electronExe, [appDir], {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('close', (code, signal) => {
  if (code === null) {
    console.error('electron exited with signal', signal)
    process.exit(1)
  }
  process.exit(code)
})
