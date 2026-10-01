import { Routes, Route } from 'react-router-dom';
import Splash from './components/Splash.jsx';
import AppShell from './components/AppShell.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Splash />} />
      <Route path="/app" element={<AppShell />} />
      <Route path="*" element={<Splash />} />
    </Routes>
  );
}
