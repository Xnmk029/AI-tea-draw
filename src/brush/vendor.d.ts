// p5.brush standalone 没有官方 .d.ts，按已核对过的 API 面声明（见 node_modules/p5.brush/src/index.shared.js）
declare module 'p5.brush/standalone' {
  export function createCanvas(w: number, h: number, opts?: { parent?: HTMLElement | string; pixelDensity?: number; id?: string }): HTMLCanvasElement
  export function render(): void
  export function clear(color?: string): void
  export function seed(v: number): void
  export function noiseSeed(v: number): void
  export function push(): void
  export function pop(): void
  export function translate(x: number, y: number): void
  export function scale(x: number, y?: number): void
  export function rotate(a: number): void
  export function fill(...args: (string | number)[]): void
  export function noFill(): void
  export function wash(...args: (string | number)[]): void
  export function noWash(): void
  export function fillBleed(i: number, direction?: 'in' | 'out', angle?: number | null): void
  export function fillTexture(texture?: number, border?: number, scatter?: boolean): void
  export function set(name: string, color: string, weight?: number): void
  export function stroke(...args: (string | number)[]): void
  export function strokeWeight(w: number): void
  export function noStroke(): void
  export function scaleBrushes(s: number): void
  export function line(x1: number, y1: number, x2: number, y2: number): unknown
  export function spline(points: number[][], curvature?: number): unknown
  export function polygon(points: number[][]): unknown
  export function beginShape(curvature?: number): void
  export function vertex(x: number, y: number, pressure?: number): void
  export function endShape(close?: boolean): unknown
  export function beginStroke(type: 'line' | 'curve' | 'points', x: number, y: number): void
  export function move(angle: number, length: number, pressure?: number): void
  export function endStroke(): void
}
