# 01. `.iam.wasm` コンテナ仕様 (normative)

## 1. 定義

`.iam.wasm` ファイルは、次の 2 条件を満たす **有効な WebAssembly バイナリ** である。

1. IAM エンジン ABI（[04_host_api_spec.md](./04_host_api_spec.md)）を実装した WASM モジュールであること。
2. 名前が `iam.pack` の **カスタムセクション**をちょうど 1 つ含み、そのペイロードが
   IAMP v1 パック（[02_iam_pack_spec.md](./02_iam_pack_spec.md)）であること。

```txt
.iam.wasm
├─ \0asm ヘッダ + 通常の WASM セクション群   ← 再生エンジン（コード・メモリ）
└─ custom section "iam.pack"                ← IAMP データパック（楽曲 + 音声 + Cue）
```

カスタムセクションは WASM 仕様上、実行に影響しないため、
`.iam.wasm` は任意の WASM ランタイムでそのままインスタンス化できる。

## 2. 構築（エクスポート）

```txt
iam_wasm = strip_iam_pack(engine_wasm) ++ custom_section("iam.pack", iamp_bytes)
```

- 入力 `engine_wasm` に既存の `iam.pack` セクションがある場合は**必ず除去**してから付加する
  （`.iam.wasm` 自体をエンジン入力にした再パックを可能にするため）。
- カスタムセクションは慣例によりバイナリ末尾へ付加する（位置は規定しない。
  読み取り側は位置に依存してはならない）。

ビルドにコンパイラは不要で、純粋なバイト列操作のみで完了する。
参照実装: `packages/iam-pack/src/wasm-container.ts` の `buildIamWasm()` / `extractPack()`。

## 3. 読み取り（ホスト）

ホストは次の手順で再生する。

```txt
1. bytes  = .iam.wasm ファイルを読む
2. pack   = bytes から custom section "iam.pack" を抽出   （WASMパーサは40行程度で書ける）
3. module = WebAssembly.compile(bytes)                     （同じ bytes をそのまま使う）
4. inst   = instantiate(module)                            （import は不要 = 空）
5. ptr    = inst.iam_alloc(pack.length); メモリへコピー
6. inst.iam_load_pack(ptr, pack.length)  → 0 で成功
7. inst.iam_init(sampleRate, channels)
8. inst.iam_play() / iam_set_rtpc() / …
9. 毎オーディオブロック: inst.iam_process(outPtr, frames)
```

エンジンは **import を一切要求しない**（WASI 不要・ホスト関数不要）。
したがってサンドボックス性は WASM の線形メモリ境界そのものであり、
ファイル・ネットワーク・システムへのアクセス能力を構造的に持たない。

## 4. メタデータの読み取り

セクション名 / RTPC 名 / Cue 名と ID の対応は IAMP パック内の各チャンクに含まれる。
ホストは `iam.pack` をパースするだけで（モジュールを実行せずに）
「この音楽が受け付けるパラメータ一覧」を列挙できる。
これにより汎用プレイヤーは任意の `.iam.wasm` に対して自動で UI を生成できる
（参照実装: `examples/demo-host/`）。

## 5. MIME タイプ / 拡張子

| 項目 | 値 |
|---|---|
| 拡張子 | `.iam.wasm`（慣例として二重拡張子） |
| MIME | `application/wasm`（WASM として配信可能であること優先） |
| マジック | 先頭 4 バイト `\0asm`、かつ `iam.pack` セクションの存在で判定 |

## 6. 設計根拠（informative）

- **単一ファイル主義**: `.iam.json` などのサイドカーを必須にしない。
  メタデータはパック内にあり、ファイル 1 つの受け渡しで完結する。
- **wasm-as-container**: ZIP 等の独自コンテナでなく WASM カスタムセクションを使うことで、
  「ファイルそのものが実行可能な再生器」になり、二重配布・バージョン不整合が起きない。
- **エンジン更新**: エンジンのバグ修正は `strip + 再付加` で既存ファイルに適用できる
  （パックは後方互換、ABI はバージョン番号で検査）。
