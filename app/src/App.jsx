import { Routes, Route } from 'react-router-dom';
import Splash from './components/Splash.jsx';
import AppShell from './components/AppShell.jsx';
import WidgetPage from './widgets/WidgetPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Splash />} />
      <Route path="/app" element={<AppShell />} />
      {/* OmniOne's floating windows: presence, emotion, neural. */}
      <Route path="/widget/:kind" element={<WidgetPage />} />
      <Route path="*" element={<Splash />} />
    </Routes>
  );
}
