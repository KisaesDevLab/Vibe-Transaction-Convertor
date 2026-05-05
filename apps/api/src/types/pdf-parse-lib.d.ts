// pdf-parse only ships @types for the package root. The lib path skips
// the package's debug auto-load — we re-declare it here.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse from 'pdf-parse';
  export default pdfParse;
}
