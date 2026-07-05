# 05. ランタイム再生セマンティクス (normative)

エンジン（`engine/src/runtime.rs`）が保証する再生時の振る舞い。

## 1. 時間モデル

- 基準クロックは **バンクサンプル**（`bank_sample_rate`）上の Section ローカル位置。
- 拍⇔サンプル: `samples_per_beat = bank_sample_rate × 60 / bpm(section)`。
  Section の `bpm = 0` はプロジェクト BPM を継承。拍子も同様。
- 出力サンプルレート（`iam_init`）がバンクと異なる場合、線形補間でレート変換する。
- 再生レート `r`（`iam_set_rate`）はクロック進行に乗算される:
  `Δpos = bank_sr / out_sr × r`（出力1フレームあたり）。

## 2. 境界駆動レンダリング

`iam_process` は内部で、**次の境界イベントちょうどまで**のチャンクに分割して描画する。

境界 = ① pending 遷移の実行位置 ② Anchor 位置 ③ 拍線/小節線（Binding がある場合のみ）
④ Section 終端（順方向）/ 位置 0（逆方向）⑤ 予約済み oneShot の発火位置

したがって遷移・ループ・トリガ発火は**サンプル精度**であり、ブロックサイズや
レート値に依存しない。1 チャンクは最大 256 フレーム。

## 3. Section プレイヤー

- 常に高々 1 つの **main プレイヤー**（音楽クロックの主体）と、
  クロスフェード中の **fading プレイヤー**（最大計 8）が存在する。
- fading プレイヤーはトリガを発火させない。ループ Section なら無音遷移なしで巻き戻り、
  フェード完了（gain=0）で破棄される。
- 全プレイヤー消滅時（かつ pending なし）に `ended` イベントを発火し停止状態になる。

## 4. 遷移 (goto) の実行手順

1. Cue が `goto` を発行 → `timing` から実行位置 `at` を解決し pending に格納
   （既存の pending は**置換** = 後勝ち）。`gotoScheduled` イベント。
2. main プレイヤーが `at` に到達した時点で:
   - crossfade: 旧 main は fading 化し `fade_ms` で減衰。新プレイヤーは 0→1 で立ち上がる（線形）。
   - cut: 旧 main は即時破棄、新プレイヤーは即時フルゲイン。
3. `sectionChanged` イベント → 新 Section の `sectionStart` トリガ発火。
4. 停止中に `goto` が発行された場合は対象 Section を即時再生開始する。

`stop(timing)` も同じ pending 機構で「音楽的な位置で止まる」を実現する。
timing 付き `setTrackGain`（v3, opcode 0x0A）も同様に発火位置を予約し、
境界ちょうどでゲインスムーザを起動する（複数トラック分を同時に保持できる）。

### 4.1 横遷移（bridge / トランジションセグメント, v2）

`goto`/`gotoRandom` に `bridge`（Section id）を指定すると、遷移は
**A → bridge → 目的地**を経由する。`at` 到達時に bridge をワンショット（ループ無効化）
として新 main にスポーンし、bridge の**セクション終端**で本来の目的地への遷移を
後続 pending として予約する（§5 の機構を再利用）。`sectionChanged` は A→bridge、
bridge→目的地の 2 回発火。無効な bridge id は直接遷移へデグレード。
詳細は [06_wclap_midi_bridges.md](./06_wclap_midi_bridges.md)。

### 4.2 トラック単位の遷移（gotoTrack, v3）

`gotoTrack` は **main プレイヤーの 1 トラックスロット**の内容だけを、別セクションの
トラックへ差し替える（他のトラックは鳴り続ける）。

- 対象 `section` が再生中の main セクションでない場合は**無視**される。
- `timing` で実行位置を予約（スロットごとに後勝ち。§2 の境界にもなる）。
- 実行時、スロットに**オーバーライド**が設定される: 以後そのスロットは
  ソーストラックの内容を **beat 基準で main タイムラインに同期**して描画する
  （`src_pos_beats = main_pos_beats mod src_length_beats`。BPM が異なる場合も
  拍で対応し、ソース長で折り返す）。
- crossfade 指定時は新旧ソースを `fade_ms` でミックスする。**ミキサ状態
  （volume / pan / mute / cue ゲイン / ブレンド曲線）は常に宛先スロット側**が
  適用される。
- instrument トラックでは MIDI ストリームが境界で切り替わり、旧ストリームの
  楽器インスタンスへ**対象限定の All-Notes-Off**（status=2, instance 指定）を送る。
  ノートはソーストラックの楽器インスタンスへルーティングされる。
- `src_section = NONE_ID` でオーバーライド解除（crossfade 可）。
- **セクション遷移（goto / play / ループではない切替）でオーバーライドと
  予約はすべて破棄**される — 新しいセクションは常に素の状態で始まる。
- `trackGoto` イベント（type 10）で通知される。

## 5. Section 終端の処理順序（順方向）

```txt
1. sectionEnd トリガの Cue を実行        ← ここで goto を積めば 2 で即実行される
2. pending 遷移が終端位置以前なら実行
3. loop_enabled なら loop_start_beats へ巻き戻り（`looped` イベント）
4. いずれもなければ main 終了 → 全消滅で `ended`
```

「ループ前提でボタンで終わる音楽」は、手動 Cue で
`goto(Outro, timing=sectionEnd)` を積む → 現ループの終端で Outro（非ループ）へ遷移 →
鳴り終わって `ended`、という形で実現する。

## 6. 逆再生・レート 0

- `rate < 0` のとき、クロックは逆進する。`nextBeat / nextBar` は**逆方向の直近の格子**、
  `sectionEnd` は**位置 0** と解釈される。
- 位置 0 を逆方向に越えるとき: ループ Section は終端へ巻き戻る。非ループは main 終了。
- Anchor / 拍 / 小節トリガは**通過方向に関係なく**横断時に発火する。
- `rate = 0` は出力凍結（無音ではなく、位置が進まない＝同一サンプルの保持はしない。
  アイテムサンプリングが停止するため実質無音）。境界は発生しない。
- oneShot（スティンガー）は常に順方向・速度 `|rate|` で再生される。

## 7. RTPC

- `iam_set_rtpc` は値を `[min,max]` にクランプ（`min >= max` なら無効）し、
  値が実際に変化した場合のみ `rtpcChanged` トリガ・イベントを発火する。
- `smoothing_ms` は**オーディオレートの内部値**（将来のゲイン変調用）の線形平滑化であり、
  **Cue 条件が読む値は常に最後に設定された値（target）**。
  ロジックが平滑化遅延の影響を受けることはない。
- Cue の `setRtpc` アクションはホスト設定と同経路（再帰深度 8 まで）。

## 8. ミキシング

```txt
sample = Σ players Σ tracks Σ items(実効ソース)
         item.gain × itemFade × track.volume × trackGainOverride(平滑)
         × blendGain(RTPC曲線, v3) × crossfadeWeight(gotoTrack, v3) × playerFade
         → pan → Σ → 出力チャンネル
```

- pan: モノラル素材は等パワー（√((1∓p)/2)）、ステレオ素材はバランス減衰。
- 出力 1ch 指定時は L/R 平均でダウンミックス。
- Item のフェードイン/アウトは拍単位の線形フェード。
- クリッピングは行わない（ホスト側でリミッタを掛けること）。

### 8.0 縦ブレンド（BLND, v3）

- 各 (Section, Track) に割り当てられたブレンド曲線は、**平滑化済み RTPC 値**を
  区分線形補間した係数として毎ブロック評価される（範囲外はクランプ、複数曲線は乗算）。
- `smoothing_ms` を持つ RTPC ではフェードもオーディオレートで滑らかになる。
- instrument トラックには `iam_instrument_gain` を通じて同じ係数が適用される
  （v3 から cue ゲイン・ブレンドも反映される）。

### 8.1 MIDI（instrument トラック, v2）

- instrument トラックのノートは PCM ミックスには寄与せず、`iam_poll_midi` 経由で
  サンプル精度の MIDI イベントとして出力される（`frame_offset` 付き）。実際の発音は
  JS/AudioWorklet 側の WCLAP 楽器プラグインが行う。
- **前進再生のみ**発火。セクション切替・`stop` 時に All-Notes-Off を broadcast。
- MIDI を発火するのは main プレイヤーの Section のみ（fading/bridge 元の旧プレイヤーは
  発火しない）。詳細は [06_wclap_midi_bridges.md](./06_wclap_midi_bridges.md)。

## 9. トリガ発火規則

- Anchor / 拍 / 小節は区間 `(prev, current]`（逆方向は `[current, prev)`）の横断で発火。
- プレイヤー生成直後・シーク直後は、**ちょうどその位置にある**境界も発火する
  （Anchor=0 の `Entry` が Section 開始時に鳴る等）。
- 同一位置に複数の境界が重なった場合の順序: Anchor → beat → bar → pending → 終端処理。
- Cue 連鎖（Cue が Cue を呼ぶ）は深さ 8 で打ち切り。

## 10. 安全性・リソース上限

| 項目 | 上限 |
|---|---|
| 同時 Section プレイヤー | 8（超過時は最古を破棄） |
| 同時 oneShot | 16（超過時は最古を破棄） |
| 予約 setTrackGainTimed / gotoTrack (v3) | 各 64 |
| イベントキュー | 256（溢れは新規破棄） |
| Cue 再帰深度 | 8 |
| VM スタック | 64 / 条件バイトコード 64KiB |
| 1 process 内のスケジューリングループ | 4096 回（暴走防止の安全弁） |

エンジンはパース時に全参照を検証するため、再生中に未定義参照で停止することはない。
不正な実行時 ID（存在しない Section への goto 等）は**無視**される。
