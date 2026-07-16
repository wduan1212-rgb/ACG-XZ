# 第三方依赖许可映射

精确版本以 `package-lock.json` 为准。下表列出直接依赖和参与当前静态构建的开发依赖；
对应许可证全文保存在 `licenses/`，无需提交 `node_modules/`。

| 包 | 快照版本 | 许可证 | 许可证文件 |
| --- | ---: | --- | --- |
| next | 16.2.9 | MIT | `licenses/next-MIT.md` |
| react | 19.2.4 | MIT | `licenses/react-MIT.txt` |
| react-dom | 19.2.4 | MIT | `licenses/react-dom-MIT.txt` |
| zustand | 5.0.14 | MIT | `licenses/zustand-MIT.txt` |
| lucide-react | 1.22.0 | ISC | `licenses/lucide-react-ISC.txt` |
| geist | 1.7.2 | SIL Open Font License 1.1 | `licenses/geist-OFL-1.1.txt` |
| tailwindcss | 4.3.2 | MIT | `licenses/tailwindcss-MIT.txt` |
| @tailwindcss/postcss | 4.3.2 | MIT | `licenses/tailwindcss-postcss-MIT.txt` |
| typescript | 5.9.3 | Apache-2.0 | `licenses/typescript-Apache-2.0.txt` |
| eslint | 9.39.4 | MIT | `licenses/eslint-MIT.txt` |
| eslint-config-next | 16.2.9 | MIT | 使用 `licenses/next-MIT.md` |
| @types/node | 20.19.43 | MIT | `licenses/types-node-MIT.txt` |
| @types/react | 19.2.17 | MIT | `licenses/types-react-MIT.txt` |
| @types/react-dom | 19.2.3 | MIT | `licenses/types-react-dom-MIT.txt` |

`package-lock.json` 同时记录传递依赖。重建或升级依赖后，应重新核对 lockfile 中的许可证，
并在新增非 MIT/ISC/OFL/Apache-2.0 依赖时更新本映射及对应许可证全文。
