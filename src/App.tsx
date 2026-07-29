import logo from "../src-tauri/icons/icon.png";
import "./App.css";

function App() {
  return (
    <main className="scaffold">
      <img className="scaffold__logo" src={logo} alt="" width="72" height="72" />
      <p className="scaffold__eyebrow">Native asset collection</p>
      <h1>X Traversal</h1>
      <p className="scaffold__copy">
        The Tauri workspace is ready. The Python application remains available
        as a verified fallback while processing moves to Rust.
      </p>
    </main>
  );
}

export default App;
