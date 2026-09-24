// 開発用: 任意のタイミングで描画してサーバーへ PNG を送る（ペイン非表示でも確認できるように）
export function installShot(renderer, renderFrame) {
  window.__shot = async (name = 'shot', frames = 1, { snap = true } = {}) => {
    const post = window.__kani && window.__kani.post;
    if (post && snap) post.snapFocus = true;
    for (let i = 0; i < frames; i++) renderFrame();
    if (post) post.snapFocus = false;
    const url = renderer.domElement.toDataURL('image/png');
    const r = await fetch('/__shot?name=' + encodeURIComponent(name), { method: 'POST', body: url });
    return r.ok ? 'saved ' + name : 'failed';
  };
  // カメラを対象へ向けて撮る
  window.__look = (px, py, pz, tx, ty, tz) => {
    const k = window.__kani;
    k.camera.position.set(px, py, pz);
    k.controls.target.set(tx, ty, tz);
    k.controls.update();
  };
}
