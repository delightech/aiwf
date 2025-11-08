# aiwf – Mastra Workflow

コマース × インフルエンサー領域の他社事例を OpenAI (ChatGPT) で調査し、売上やGMVなどの数値を抽出、その結果を Slack へ通知する Mastra ワークフローです。

## セットアップ

1. 依存関係をインストール

   ```bash
   npm install
   ```

2. 環境変数を設定

   ```bash
   cp .env.example .env
   # OPENAI_API_KEY と (任意で) SLACK_WEBHOOK_URL, SLACK_USERNAME を編集
   ```

   - `OPENAI_API_KEY`: ChatGPT 呼び出しに利用 (gpt-4o-mini)。
   - `SLACK_WEBHOOK_URL`: 設定すると調査結果を指定チャンネルにポスト。未設定の場合は標準出力のみ。

3. TypeScript ビルドチェック

   ```bash
   npm run lint
   ```

## 主なスクリプト

| コマンド | 説明 |
| --- | --- |
| `npm run dev` | Mastra の開発サーバーを起動し、ブラウザ UI からワークフロー実行/確認が可能。 |
| `npm run workflow` | `src/run-commerce-influencer.ts` を通じてワークフローを単発実行。引数に JSON を渡すと入力を上書きできます。 |
| `npm run build` | `dist/` に TypeScript をコンパイル。 |

### 単発実行の例

```bash
npm run workflow -- '"{\"focusKeyword\":\"コスメ x インフルエンサー\",\"geography\":\"APAC\",\"minExamples\":4}"'
```

### ワークフローの流れ

1. **collect-competitor-cases**: 指定キーワード/地域に合う他社事例を ChatGPT で抽出し、主要情報を構造化。
2. **enrich-cases-with-metrics**: 抽出結果に対し、売上やCVRなどの数値/KPIを ChatGPT で補完。
3. **summarize-and-notify**: まとめテキストを生成し、Slack Webhook へブロック形式で通知 (任意)。

## 追加メモ

- Mastra への登録内容は `src/mastra/index.ts`、設定エントリは `mastra.config.ts` にあります。
- Slack 送信をスキップした場合はサマリが `console.log` に出力されます。
- 追加のメトリクスを追跡したい場合は `metricFocus` 入力 (JSON 配列) に項目を足してください。
