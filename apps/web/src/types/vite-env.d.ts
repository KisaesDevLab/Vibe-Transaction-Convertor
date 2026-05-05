/// <reference types="vite/client" />

declare module '*?url' {
  const src: string;
  export default src;
}

// Vite's ?raw import returns the file contents verbatim — used for
// markdown topics in the in-app help system.
declare module '*?raw' {
  const content: string;
  export default content;
}
