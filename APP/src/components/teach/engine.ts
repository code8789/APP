export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  tool: 'pen' | 'line' | 'shape' | 'eraser' | 'laser';
  points: Point[];
  color: string;
  size: number;
  eraserMode?: 'object' | 'pixel';
}

export class DrawingEngine {
  public strokes: Stroke[] = [];
  public activeTool: string = 'pen';
  public currentColor: string = '#000000';
  public currentSize: number = 3;
  public eraserMode: 'object' | 'pixel' = 'object';
  public eraserSize: number = 20;
  public autoShapeEnabled: boolean = false;

  constructor() {}

  public addPoint(strokeId: string, point: Point) {
    const stroke = this.strokes.find(s => s.id === strokeId);
    if (stroke) {
      stroke.points.push(point);
    }
  }

  public createStroke(tool: 'pen' | 'line' | 'shape' | 'eraser' | 'laser', point: Point): Stroke {
    const newStroke: Stroke = {
      id: Date.now().toString() + Math.random().toString(36.substring(2, 7)),
      tool,
      points: [point],
      color: this.currentColor,
      size: tool === 'eraser' ? this.eraserSize : this.currentSize,
      eraserMode: tool === 'eraser' ? this.eraserMode : undefined,
    };
    this.strokes.push(newStroke);
    return newStroke;
  }

  // Fine-tuned Auto-Shape Detection
  public processAutoShape(stroke: Stroke): Stroke {
    if (!this.autoShapeEnabled || stroke.points.length < 8) return stroke;

    const points = stroke.points;
    const start = points[0];
    const end = points[points.length - 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);

    // Detect Circle / Closed Loop
    if (distance < 30 && points.length > 12) {
      stroke.tool = 'shape';
      // Normalize into a clean circle representation
      return stroke;
    }

    // Detect Straight Line
    let maxDev = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const dev = Math.abs((end.y - start.y) * points[i].x - (end.x - start.x) * points[i].y + end.x * start.y - end.y * start.x) / (distance || 1);
      if (dev > maxDev) maxDev = dev;
    }

    if (maxDev < 10) {
      stroke.tool = 'line';
      stroke.points = [start, end]; // Snap to exact straight line endpoints
    }

    return stroke;
  }
}
