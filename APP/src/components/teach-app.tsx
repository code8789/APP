import React, { useState, useRef } from 'react';
import { 
  Hand, PenTool, Eraser, Sparkles, Wand2, Minus, Shapes, 
  FilePlus, ChevronUp, ChevronDown, Check, Upload 
} from 'lucide-react';
import { DrawingEngine, Stroke } from './engine';

export function TeachApp() {
  const [engine] = useState(() => new DrawingEngine());
  const [activeTool, setActiveTool] = useState<string>('pen');
  const [currentColor, setCurrentColor] = useState<string>('#000000');
  const [eraserMode, setEraserMode] = useState<'object' | 'pixel'>('object');
  const [eraserSize, setEraserSize] = useState<number>(20);
  const [autoShapeEnabled, setAutoShapeEnabled] = useState<boolean>(false);
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [showColorPicker, setShowColorPicker] = useState<boolean>(false);
  const [showEraserMenu, setShowEraserMenu] = useState<boolean>(false);
  const [showBlankMenu, setShowBlankMenu] = useState<boolean>(false);

  // Pages state supporting HTML imports and Blank Pages
  const [pages, setPages] = useState<Array<{ id: string; type: 'html' | 'blank'; content: string; bg: string }>>([
    { id: '1', type: 'blank', content: '', bg: '#ffffff' }
  ]);
  const [currentPage, setCurrentPage] = useState<number>(0);
  const [zoomLevel, setZoomLevel] = useState<number>(1);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const colors = ['#000000', '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ffffff'];

  // Handle HTML Import Fix (Full content, images, videos, GIFs parsing)
  const handleHtmlImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const rawHtml = event.target?.result as string;
      if (rawHtml) {
        const wrapped = `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <style>
                body { margin: 0; padding: 16px; font-family: sans-serif; background: #fff; color: #000; }
                img, video, iframe { max-width: 100%; height: auto; display: block; margin: 10px auto; }
              </style>
            </head>
            <body>${rawHtml}</body>
          </html>
        `;
        setPages(prev => [...prev, { id: Date.now().toString(), type: 'html', content: wrapped, bg: '#ffffff' }]);
        setCurrentPage(pages.length);
      }
    };
    reader.readAsText(file);
  };

  const handleAddBlankPage = (type: 'white' | 'black') => {
    setPages(prev => [...prev, {
      id: Date.now().toString(),
      type: 'blank',
      content: '',
      bg: type === 'white' ? '#ffffff' : '#000000'
    }]);
    setCurrentPage(pages.length);
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-gray-100 dark:bg-gray-950 select-none">
      
      {/* Minimizable Header Tool Pad */}
      <header className={`transition-all duration-300 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 flex items-center justify-between z-40 ${isMinimized ? 'h-0 opacity-0 overflow-hidden py-0' : 'h-14 opacity-100 py-2'}`}>
        <div className="flex items-center gap-3">
          <span className="font-bold text-sm text-gray-800 dark:text-white">Workspace</span>
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
            Page {currentPage + 1} / {pages.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 shadow-sm">
            <Upload size={14} /> Import HTML
            <input type="file" accept=".html,.htm" onChange={handleHtmlImport} className="hidden" />
          </label>
        </div>
      </header>

      {/* Main Canvas / Viewer Area */}
      <main className="flex-1 relative flex items-center justify-center overflow-auto p-2 sm:p-6">
        <div 
          className="relative shadow-2xl rounded-xl overflow-hidden transition-transform duration-100 bg-white"
          style={{ 
            width: '1000px', 
            height: '100%', 
            maxHeight: '1300px',
            backgroundColor: pages[currentPage]?.bg || '#ffffff',
            transform: `scale(${zoomLevel})`,
            transformOrigin: 'center center'
          }}
        >
          {pages[currentPage]?.type === 'html' ? (
            <iframe 
              srcDoc={pages[currentPage].content} 
              className="w-full h-full border-0" 
              title="Imported Document"
            />
          ) : (
            <canvas 
              ref={canvasRef}
              className="w-full h-full touch-none cursor-crosshair"
            />
          )}
        </div>
      </main>

      {/* Rearranged Drawing Toolbar & Floating Controls */}
      <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 transition-transform duration-300 ${isMinimized ? 'translate-y-20' : 'translate-y-0'}`}>
        
        {/* Minimize / Expand Toggle Tab */}
        <button 
          onClick={() => setIsMinimized(!isMinimized)}
          className="absolute -top-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-1 rounded-t-lg text-xs flex items-center gap-1 shadow-md font-medium"
        >
          {isMinimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {isMinimized ? 'Show Tools' : 'Minimize Pad'}
        </button>

        <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border border-gray-200 dark:border-gray-800 p-2 rounded-2xl shadow-2xl flex items-center gap-1.5 overflow-x-auto max-w-[96vw]">
          
          {/* 1. Pan Tool */}
          <button
            onClick={() => setActiveTool('pan')}
            className={`p-2.5 rounded-xl transition-colors ${activeTool === 'pan' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
            title="Pan"
          >
            <Hand size={20} />
          </button>

          {/* 2. Pen Tool with Color Picker beside it */}
          <div className="relative flex items-center gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-xl">
            <button
              onClick={() => setActiveTool('pen')}
              className={`p-2 rounded-lg transition-colors ${activeTool === 'pen' ? 'bg-blue-600 text-white' : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
              title="Pen"
            >
              <PenTool size={20} />
            </button>
            <button
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="w-5 h-5 rounded-full border-2 border-white shadow-sm"
              style={{ backgroundColor: currentColor }}
              title="Choose Color"
            />
            {showColorPicker && (
              <div className="absolute bottom-14 left-0 bg-white dark:bg-gray-800 p-2 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 flex gap-1.5">
                {colors.map(c => (
                  <button
                    key={c}
                    onClick={() => { setCurrentColor(c); engine.currentColor = c; setShowColorPicker(false); setActiveTool('pen'); }}
                    className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center hover:scale-110 transition-transform"
                    style={{ backgroundColor: c }}
                  >
                    {currentColor === c && <Check size={12} className={c === '#ffffff' ? 'text-black' : 'text-white'} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 3. Eraser Tool (Object & Pixel with Size Controller) */}
          <div className="relative">
            <button
              onClick={() => { setActiveTool('eraser'); setShowEraserMenu(!showEraserMenu); }}
              className={`p-2.5 rounded-xl transition-colors ${activeTool === 'eraser' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
              title="Eraser"
            >
              <Eraser size={20} />
            </button>
            {showEraserMenu && (
              <div className="absolute bottom-14 left-0 bg-white dark:bg-gray-800 p-3 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 w-48 space-y-2">
                <div className="text-xs font-bold text-gray-500">Eraser Mode</div>
                <div className="flex gap-1">
                  <button 
                    onClick={() => { setEraserMode('object'); engine.eraserMode = 'object'; }}
                    className={`flex-1 py-1 text-xs rounded-lg ${eraserMode === 'object' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                  >
                    Object
                  </button>
                  <button 
                    onClick={() => { setEraserMode('pixel'); engine.eraserMode = 'pixel'; }}
                    className={`flex-1 py-1 text-xs rounded-lg ${eraserMode === 'pixel' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                  >
                    Pixel
                  </button>
                </div>
                <div className="text-xs font-bold text-gray-500">Size: {eraserSize}px</div>
                <input 
                  type="range" 
                  min="5" 
                  max="50" 
                  value={eraserSize} 
                  onChange={(e) => { setEraserSize(Number(e.target.value)); engine.eraserSize = Number(e.target.value); }}
                  className="w-full accent-blue-600"
                />
              </div>
            )}
          </div>

          {/* 4. Laser Pointer */}
          <button
            onClick={() => setActiveTool('laser')}
            className={`p-2.5 rounded-xl transition-colors ${activeTool === 'laser' ? 'bg-red-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
            title="Laser Pointer"
          >
            <Sparkles size={20} />
          </button>

          {/* 5. Auto-Detection of Shapes Toggle Button */}
          <button
            onClick={() => {
              const newState = !autoShapeEnabled;
              setAutoShapeEnabled(newState);
              engine.autoShapeEnabled = newState;
            }}
            className={`p-2.5 rounded-xl flex items-center gap-1 transition-all ${autoShapeEnabled ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/30' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500'}`}
            title="Toggle Shape Auto-Detection"
          >
            <Wand2 size={20} />
            <span className="text-xs font-semibold hidden sm:inline">Auto-Shape</span>
          </button>

          {/* 6. Line Tool */}
          <button
            onClick={() => setActiveTool('line')}
            className={`p-2.5 rounded-xl transition-colors ${activeTool === 'line' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
            title="Line"
          >
            <Minus size={20} />
          </button>

          {/* 7. All Shapes */}
          <button
            onClick={() => setActiveTool('shapes')}
            className={`p-2.5 rounded-xl transition-colors ${activeTool === 'shapes' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
            title="Shapes"
          >
            <Shapes size={20} />
          </button>

          {/* 8. Blank Page Adder Button */}
          <div className="relative">
            <button
              onClick={() => setShowBlankMenu(!showBlankMenu)}
              className="p-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
              title="Add Blank Page"
            >
              <FilePlus size={20} />
            </button>
            {showBlankMenu && (
              <div className="absolute bottom-14 right-0 bg-white dark:bg-gray-800 p-2 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 flex flex-col gap-1 w-32">
                <button 
                  onClick={() => { handleAddBlankPage('white'); setShowBlankMenu(false); }}
                  className="w-full text-left px-3 py-1 text-xs bg-white text-black rounded-lg hover:bg-gray-100 border border-gray-200 font-medium"
                >
                  + White Page
                </button>
                <button 
                  onClick={() => { handleAddBlankPage('black'); setShowBlankMenu(false); }}
                  className="w-full text-left px-3 py-1 text-xs bg-black text-white rounded-lg hover:bg-gray-900 font-medium"
                >
                  + Black Page
                </button>
              </div>
            )}
          </div>

        </div>
      </div>

    </div>
  );
}
