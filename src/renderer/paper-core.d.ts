// paper-core is paper.js without PaperScript (no acorn): same API, smaller bundle
declare module 'paper/dist/paper-core' {
  import paper from 'paper'
  export default paper
}
