import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App'

const root = createRoot(document.getElementById('root'))

root.render(
  <HashRouter>
    <App />
  </HashRouter>
)
