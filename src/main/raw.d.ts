// text files bundled into the main process (Vite "?raw" imports)
declare module '*.md?raw' {
  const text: string
  export default text
}
