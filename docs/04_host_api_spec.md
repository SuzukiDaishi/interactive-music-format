# 04. ホスト API 仕様 (normative)

## 1. WASM ABI（低レベル / 言語非依存）

`.iam.wasm` がエクスポートするシンボル。**import は空**（WASI 不要）。
すべて単一スレッドから呼ぶこと。`iam_process` と制御呼び出しは同一スレッド
（ブラウザでは AudioWorklet 内）で行うのが正しい使い方。

```c
// ライフサイクル
uint32_t iam_abi_version(void);                    // == 1
uint8_t* iam_alloc(uint32_t size);                 // モジュール内メモリ確保
void     iam_free(uint8_t* ptr, uint32_t size);
int32_t  iam_load_pack(const uint8_t* ptr, uint32_t len);  // 0=成功（下表）
int32_t  iam_init(uint32_t sample_rate, uint32_t channels); // channels: 1|2, 0=成功
                                                   // 何度でも呼び直し可（状態リセット）

// トランスポート
void     iam_play(void);                           // start_section から再生 + moduleStart 発火
void     iam_play_section(uint32_t section_id, uint32_t anchor_id); // 即時ハードスイッチ
void     iam_stop(float fade_ms);                  // フェードアウト停止（0=即時）
void     iam_pause(void);                          // 出力凍結（位置保持）
void     iam_resume(void);
uint32_t iam_is_playing(void);
void     iam_seek_beats(float beats);              // 現 Section 内シーク（pending 遷移は破棄）

// レンダリング（プル型）
void     iam_process(float* out, uint32_t frames); // インターリーブ f32 を frames 分書き込む

// インタラクション
void     iam_trigger_cue(uint32_t cue_id);         // 手動 Cue 発火
void     iam_set_rtpc(uint32_t rtpc_id, float v);  // bool=0/1, enum=index
float    iam_get_rtpc(uint32_t rtpc_id);           // 最後に設定された値（target）
void     iam_set_rate(float rate);                 // 再生レート [-4,4]。負=逆再生、0=フリーズ
float    iam_get_rate(void);
void     iam_set_seed(uint32_t seed);              // 乱数シード（分岐の再現用）

// 状態取得
uint32_t iam_get_section(void);                    // 現 Section ID（なし=0xFFFFFFFF）
float    iam_get_position_beats(void);
double   iam_get_position_samples(void);           // バンクサンプル単位

// イベント
uint32_t iam_poll_event(uint8_t* out16);           // 1=イベントあり（16バイト書込）, 0=空
uint32_t iam_poll_midi(uint8_t* out16);            // 1=MIDIあり（16バイト書込）, 0=空 (v2)
```

### `iam_load_pack` エラーコード

| 値 | 意味 |
|---|---|
| 0 | 成功 |
| -1 | 引数不正 |
| -2 | データが短すぎる |
| -3 | magic 不一致（IAMP でない） |
| -4 | 未対応バージョン |
| -5 | データ破損 |
| -6 | PROJ チャンク欠落 |
| -7 | 参照不整合（存在しない Section / Asset 等） |

### イベントレコード（16 バイト）

```c
struct IamEvent { uint32_t type; uint32_t a; uint32_t b; float c; };
```

| type | 名前 | a | b | c |
|---|---|---|---|---|
| 1 | sectionChanged | from Section ID（なし=NONE） | to Section ID | — |
| 2 | cueFired | Cue ID | — | — |
| 3 | gotoScheduled | 対象 Section ID | 対象 Anchor ID | 実行予定位置（バンクサンプル） |
| 4 | emit | ユーザコード | — | — |
| 5 | ended | — | — | — |
| 6 | looped | Section ID | — | — |
| 7 | oneShot | Asset ID | — | — |
| 8 | rtpcChanged | RTPC ID | — | 新しい値 |

キュー長は 256。溢れた場合は新しいイベントが破棄される。
ホストは `iam_process` 呼び出し後に空になるまでポーリングすること。

### MIDI レコード（16 バイト, v2）

instrument トラックのサンプル精度ノートを `iam_poll_midi` で取得する。

```c
struct IamMidi { uint32_t instance; uint32_t frame_offset;
                 uint8_t status; uint8_t key; uint8_t channel; uint8_t pad;
                 float velocity; };
```

- `instance`: ルーティング先プラグインインスタンス id（`NONE_ID` = 全インストゥルメントへ
  All-Notes-Off broadcast）。
- `frame_offset`: 当該 `iam_process` ブロック先頭からのサンプル位置。
- `status`: 0=NoteOff, 1=NoteOn, 2=AllNotesOff。

詳細は [06_wclap_midi_bridges.md](./06_wclap_midi_bridges.md)。WCLAP プラグインの
ホスティングは JS/AudioWorklet 層が担う（`@iam/player` の `wclap/*`）。

## 2. JavaScript / TypeScript API（`@iam/player`）

### ブラウザ（AudioWorklet）

```ts
import { IamPlayer } from '@iam/player';

const ctx = new AudioContext();
const music = await IamPlayer.load('adventure_demo.iam.wasm', ctx);
music.node.connect(ctx.destination);

music.play();
music.setRtpc('intensity', 0.8);      // 名前は数値ID・bool・enum文字列も可
music.setRtpc('weather', 'storm');
music.triggerCue('to_ending');
music.setRate(-1);                    // 逆再生
music.stop(400);

music.onEvent((e) => {
  if (e.kind === 'sectionChanged') console.log(e.fromName, '→', e.toName);
});
music.onStatus((s) => {
  // { sectionId, sectionName, positionBeats, playing, rate } 約21ms間隔
});
```

- WASM は **AudioWorklet 内でインスタンス化**され、オーディオスレッドで `iam_process` が回る。
  メインスレッドとは MessagePort で制御・イベントを往復する。
- worklet コードはライブラリ内に文字列として同梱され Blob URL で登録されるため、
  **追加ファイルの配信は不要**。

### Node.js / オフライン（同期コア）

```ts
import { IamCore } from '@iam/player';

const core = await IamCore.create(bytes);  // .iam.wasm のバイト列
core.init(48000, 2);
core.play();
const f32 = core.render(480);              // 10ms 分のインターリーブf32
const events = core.pollEvents();
```

ゲームエンジン等は `IamCore` 相当（ABI 直叩き）を各言語の WASM ランタイムで実装すればよい。

## 3. 名前解決

文字列 API（`setRtpc('intensity', …)` 等）は、パックの RTPC / SECT / CUES チャンクから
デコードした name→ID テーブルで解決する（META 不要）。
未知の名前は例外を投げる。低レベル ABI は ID のみを受け付ける。

## 4. ホスト実装ガイドライン

- **呼び出しタイミング**: 制御 API は `iam_process` の合間ならいつでも呼べる。
  遷移の量子化（次の小節頭など）はエンジン側が行うため、ホストはタイミングを気にしなくてよい。
- **rate の乱用**: `iam_set_rate` は逆再生・倍速・0（フリーズ）を許容する。
  逆再生中の `sectionEnd` タイミングは「位置 0 への到達」と解釈される。
  ループ Section は逆方向にもループする。oneShot は常に順方向（速度は |rate|）。
- **再現性**: 同じパック・同じ API 呼び出し列・同じシードに対し、エンジンは同一の
  遷移列を生成する（描画は f32 演算順序に依存するためビット同一性までは保証しない）。
- **複数モジュール**: 1 インスタンス = 1 モジュール。多重再生はインスタンスを並べる。
