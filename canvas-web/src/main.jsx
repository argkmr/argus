import { createRoot } from 'react-dom/client';
import CanvasShareView from '../../frontend/features/diagrams/CanvasShareView';
import './styles.css';

// Excalidraw creates FontFace sources while its lazy module is evaluated, so
// configure its local font root before importing that editor for the first time.
window.EXCALIDRAW_ASSET_PATH = '/assets/excalidraw/';
createRoot(document.getElementById('root')).render(<CanvasShareView/>);
