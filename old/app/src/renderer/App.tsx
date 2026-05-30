import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
// import Ps2exe from './pages/ps2exe';
import Dat from './pages/dat';
import About from './pages/about';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/about" element={<About />} />
        <Route path="/" element={<Dat />} />
      </Routes>
    </Router>
  );
}
