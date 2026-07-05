# 03. Cue VM / 条件式言語仕様 (normative)

Cue のルール条件は、f32 スタックマシン（**Cue VM**）のバイトコードとして
パック内に格納され、エンジンが解釈実行する。
任意コード実行を構造的に排除しつつ（≠ Rust/Lua スクリプト埋め込み）、
「intensity が 0.7 以上かつ現在 Battle_High でない」のような音楽ロジックを表現できる。

参照実装: VM `engine/src/vm.rs` / コンパイラ `packages/iam-pack/src/expr.ts`。

## 1. 実行モデル

- 値はすべて f32。スタック深さ上限 **64**。
- 真偽値の解釈: `|x| > 1e-9` を真とする。比較・論理演算の結果は `1.0 / 0.0`。
- プログラム終了時、スタックに**ちょうど 1 値**が残り、それが真のときルール成立。
- 異常（スタック不足 / 未知 opcode / 途中で尽きるオペランド / 終了時スタック≠1）は
  **すべて偽として評価**する（エンジンは止まらない）。
- **空のプログラム（0 バイト）は常に真**。
- ゼロ除算は 0.0 を返す。

## 2. 命令セット

| op | ニーモニック | オペランド | 動作 |
|---|---|---|---|
| 0x01 | PUSH | f32 | 即値を push |
| 0x02 | RTPC | u32 id | RTPC 値を push（bool→0/1, enum→variant index。未知 id → 0.0） |
| 0x03 | SPECIAL | u8 id | ランタイム値を push（下表） |
| 0x10 | ADD | — | a+b |
| 0x11 | SUB | — | a−b |
| 0x12 | MUL | — | a×b |
| 0x13 | DIV | — | a÷b（b≈0 のとき 0） |
| 0x14 | NEG | — | −a |
| 0x20–0x25 | LT LE GT GE EQ NE | — | 比較（EQ/NE は ε=1e-9 の許容差） |
| 0x30 | AND | — | 論理積 |
| 0x31 | OR | — | 論理和 |
| 0x32 | NOT | — | 論理否定 |

二項演算は `…, a, b → …, r`（b が後に push された側）。

### SPECIAL 一覧

| id | 名前 | 値 |
|---|---|---|
| 0 | `section` | 現在の Section ID（非再生時は NONE_ID のキャスト値） |
| 1 | `beats` | Section 内再生位置（拍） |
| 2 | `bar` | Section 内の小節番号（0 起点、floor） |
| 3 | `playing` | 再生中 1 / 停止・ポーズ 0 |
| 4 | `rand` | 一様乱数 [0,1)（評価のたびに進む。シードは `iam_set_seed`） |
| 5 | `rate` | 現在の再生レート |
| 6 | `time` | Section 内再生位置（秒） |

## 3. 式言語（オーサリング表現）

DAW / ツールは以下の infix 式をバイトコードへコンパイルする。
**式のソースは META チャンクに保存**され、配布フォーマット上はバイトコードが正。

```txt
expr    := or
or      := and ( "||" and )*
and     := cmp ( "&&" cmp )*
cmp     := add ( ("<" | "<=" | ">" | ">=" | "==" | "!=") add )?
add     := mul ( ("+" | "-") mul )*
mul     := unary ( ("*" | "/") unary )*
unary   := ("!" | "-") unary | primary
primary := number | string | identifier | "(" expr ")"
```

- **identifier**: RTPC 名 → `RTPC` 命令。または組み込み
  `section, beats, bar, playing, rand, rate, time` → `SPECIAL` 命令。
  `true` / `false` は 1 / 0。未知の識別子はコンパイルエラー。
- **string** (`'...'` または `"..."`): まず **Section 名**として解決し、その ID を定数 push。
  Section に無ければ全 enum RTPC の variant 名から検索し、その index を定数 push。
  どちらにも無ければコンパイルエラー。

### 例

```txt
intensity >= 0.7 && section != 'Battle_High'
weather == 'storm'
rand < 0.35
bar >= 4 || time > 30
!is_battle && playing
```

## 3.5. 値式（v3）

同じバイトコード・同じ式言語を**数値**として評価する用途が v3 で追加された。
`setTrackGain` / `setRtpc` / `setPluginParam` の値式スロット（docs/02 §5 の
`expr_len`/`value_expr`）はアクション**発火時に一度**評価され、静的な値フィールド
を上書きする（空・不正なバイトコードは静的値へフォールバック）。例:
`intensity * 0.5`、`1 - weather`。VM 命令セットに変更はない（スタック頂の値を
真偽ではなく数値として読むだけ）。

## 4. アクション実行

ルールは Cue 内で**先頭から順に**評価され、条件成立時にアクション列を順次適用する。
`stop_if_matched = 1` のルールが成立した場合、以降のルールは評価しない。

- `goto` / `gotoRandom` は **pending 遷移を 1 つだけ**保持する（後勝ち）。
- `setRtpc` は RTPC 変更トリガを再帰的に発火させうる。再帰深度は **8** で打ち切り。
- Cue 発火自体もイベント (`cueFired`) としてホストへ通知される。

## 5. 設計根拠（informative）

設計ドキュメントの「Cue Script は Rust 関数」という案（Developer Build）に対し、
本仕様は **Pack Build（固定エンジン + データ + VM）** を v1 の正式形式とした。

- Web 上の DAW から **rustc なしで即エクスポート**できる
- 共有ファイルを開く/鳴らすことが**安全**（任意コード実行が構造上不可能）
- ロジックがデータなのでツールによる静的解析（遷移グラフ抽出）が可能

複雑な手続き的ロジックが必要になった場合は、`version` を上げて
ループ・変数・ユーザ関数を持つ上位 VM を追加する余地を残している。
