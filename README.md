# 会場参加型カウントダウン集計

ゲーム用の集計プロトタイプです。

## 画面

- `#control`: 進行用。チーム名、開始数字、お題、ターン、回答集計、手動減点を操作します。
- `#screen`: 投影用。スコア、ターン、お題、最新票数を大きく表示します。
- `?overlay=1#screen`: OBS用。透明背景で、ターン・ミッション・各チーム点数だけを表示します。
- `#answer`: 来場者回答用。QRコードから開いて回答を送ります。

## 使い方

1. `index.html` をブラウザで開きます。
2. 進行画面でチーム名、開始数字、お題、回答制限時間を設定し、「設定を反映」を押すと受付が開始します。
3. 回答ページのURLをQRコード化して来場者に案内します。
4. 来場者が回答を送信します。
5. 来場者が回答を送ると、進行画面に `○ / ×` の件数が集計されます。
6. 集計を見て、進行画面の「手動で減点」から数字を減らします。
7. 同じお題では回答後に「回答ありがとうございます」画面になります。お題を変えて設定を反映すると、また回答できます。
8. 制限時間が過ぎると回答ページは受付終了画面になります。

## 現在の仕様

- 回答画面では `○` か `×` を選んで送信します。
- 回答はスコアに直接反映せず、進行画面に `○ / ×` の件数として表示します。
- 初期状態、初期化後、ターン送り後は回答受付終了です。
- 回答受付が開始するのは「設定を反映」を押した時だけです。
- データ保存はブラウザの `localStorage` です。
- 投影画面は `背景レイヤー`、`出演者配置レイヤー`、`スコアUIレイヤー` に分けています。
- Supabase利用時、参加者画面は5秒ごとに状態を取得します。

## 投影画面の出演者画像

[index.html](./index.html) の `cast-slot` にある `--cast-image: none` を画像URLに変えると、各チーム3名分の表示枠に画像を置けます。

例:

```html
<div class="cast-slot cast-slot-1" style="--cast-image: url('./assets/team-a-1.png')"><span>A 01</span></div>
```

画像は透過PNGを想定しています。枠の中で下揃え・等倍比率のまま表示されます。

## OBSで背景・立ち絵を別レイヤーにする場合

公開版は簡易アクセスキー付きです。進行・回答・OBS用URLには `access=321-live-8kq4` を付けて使います。キーなしで開くとロック画面になります。

OBSでは下から次の順番で重ねます。

1. デザイナー作成の背景
2. 立ち絵
3. このシステムのOBS用ブラウザソース

OBS用ブラウザソースのURL:

```text
http://127.0.0.1:8081/index.html?overlay=1#screen
```

このURLではシステム側の背景、立ち絵枠、最新票数表示を消し、透明背景のまま「1ターン目」「0に近づけろ!!」「各チーム名と点数」だけを重ねられるようにしています。

スクリーン比率が16:9ではなく、OBS側で各要素を個別に配置したい場合は次のURLを別々のブラウザソースにします。

```text
http://127.0.0.1:8081/index.html?overlay=topic#screen
http://127.0.0.1:8081/index.html?overlay=teamA#screen
http://127.0.0.1:8081/index.html?overlay=teamB#screen
```

## 本番運用: Supabase無料枠

200人規模の同時回答を想定する場合は、Google Apps Script + Googleスプレッドシート直書きではなく、Supabaseを使います。

### セットアップ

1. Supabaseで無料プロジェクトを作ります。
2. SupabaseのSQL Editorを開きます。
3. [supabase-schema.sql](./supabase-schema.sql) の中身を貼り付けて実行します。
4. Project Settings → API から `Project URL` と `anon public` key を取得します。
5. [config.js](./config.js) に次の2つを設定します。

```js
window.SUPABASE_URL = "https://xxxxx.supabase.co";
window.SUPABASE_ANON_KEY = "xxxxx";
```

6. `window.EVENT_API_URL` は旧方式の予備です。Supabase設定がある場合はSupabaseが優先されます。
7. GitHub Pagesに反映します。

### Supabase側に作られるテーブル

- `event_state`: 現在のゲーム状態
- `event_answers`: 来場者の `○ / ×` 回答ログ
- `event_manual`: 手動減点や初期化のログ

### 設計

- 回答送信は `event_answers` への1行insertだけにしています。
- 同じ端末から同じお題へ重複回答した場合は、`question_id + client_id` のユニーク制約で重複を防ぎます。
- 進行画面と投影/OBS画面だけが定期的に状態と回答数を取得します。
- 参加者画面は5秒ごとに状態を取得し、お題変更や受付状態を反映します。
- スコアへの反映は今まで通り手動減点です。

### 旧Google Apps Script版

旧方式を使いたい場合は [google-apps-script/Code.gs](./google-apps-script/Code.gs) をApps Scriptに貼り付け、発行URLを [config.js](./config.js) の `window.EVENT_API_URL` に入れます。
ただし、2026-08-25の負荷テストでは200人同時回答に耐えない結果でした。

決めたいこと:

- 回答は「文字数」で減らすのか、「人数/票数」で減らすのか
- 手動減点後に取り消し操作が必要か
- 1人1回制限が必要か
- 会場Wi-Fi内だけで使うのか、インターネット公開URLで使うのか
