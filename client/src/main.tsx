import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Routes, Route, Navigate, BrowserRouter } from 'react-router'
import { IndexPage } from './pages/IndexPage.tsx'
import { PlayerPage } from './pages/PlayerPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import './style.css'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<IndexPage />} />
        <Route path="/players/:accountId" element={<PlayerPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
