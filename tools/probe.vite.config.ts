// 把 tools/probe_scene.ts 打成一个 Node 可直接跑的 ESM 包，
// 用来在命令行里校验程序化场景构建（浏览器外的 headless 回归检查）。
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // 关键：按 SSR（Node）构建，否则 node:fs 会被替换成浏览器空壳
    ssr: true,
    outDir: 'tools/_probe_out',
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    lib: {
      entry: 'tools/probe_scene.ts',
      formats: ['es'],
      fileName: () => 'probe.mjs',
    },
  },
});
