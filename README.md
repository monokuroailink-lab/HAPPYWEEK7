# HAPPYWEEK7

> I'd be happy to work seven days a week!

`HAPPYWEEK7` は、Claude Code の会話文に raw tool-call markup が漏れたときに、ローカル hook で検知して言い直しを要求するための小さなCLIです。

コマンド名は `week7` です。

## 要件定義

目的:

- Claude Code が内部ツール呼び出し用の raw markup を会話文に漏らしたことを検知する
- 漏れた事実は Claude Code のログ上で見えるようにする
- デフォルトでは1回だけ言い直しを要求し、無限ループを避ける
- 判定はAIに依存せず、ローカルの deterministic な正規表現とSHA256ハッシュだけで行う
- Windows と macOS の両方で動く

非目的:

- Claude の挙動を100%修正すること
- Claude Code のストリーミング表示を途中で改変すること
- ネットワーク通信や外部AI判定を使うこと

## 動作モード

```bash
week7 install --mode warn
```

検知してログに残すだけです。Claude への差し戻しはしません。

```bash
week7 install --mode rewrite-once
```

デフォルトです。同じセッションの同じ漏れハッシュにつき、1回だけ差し戻します。

```bash
week7 install --mode strict
```

漏れがある限り差し戻します。ループしやすいので通常は非推奨です。

## ブロック時の表示

Claude Code の `Stop` hook 上では、以下のような理由が表示されます。

```text
週七出勤喜んで！

HAPPYWEEK7 blocked a raw tool-call leak.
Rewrite the response without exposing internal tool-call markup.
Mode: rewrite-once.
This is a deterministic local hook, not an AI check.
Leak hash: ...
```

## 使い方

### npm からインストール

公開後は Windows/macOS どちらも同じコマンドで使えます。

```bash
npm install -g happyweek7
week7 install --mode rewrite-once
week7 status
```

必要環境:

- Node.js 18 以上
- Claude Code が `~/.claude/settings.json` を使っていること

### GitHub からインストール

まだnpm公開前なら、GitHub repo から直接インストールできます。

```bash
npm install -g github:monokuroailink-lab/HAPPYWEEK7
week7 install --mode rewrite-once
```

### 開発フォルダから実行

開発フォルダから直接実行:

```bash
node ./bin/week7.js test
node ./bin/week7.js install --mode rewrite-once
node ./bin/week7.js status
node ./bin/week7.js logs --tail 50
node ./bin/week7.js uninstall
```

npm link する場合:

```bash
npm link
week7 install --mode rewrite-once
week7 status
```

## 配布手順

### npm公開

```bash
npm login
npm test
npm run pack:dry-run
npm publish
```

公開後の利用者向けコマンド:

```bash
npm install -g happyweek7
week7 install --mode rewrite-once
```

### GitHub Releases

Node.js依存のCLIとして配る場合、GitHub repo にこのフォルダをpushするだけでも使えます。

```bash
npm install -g github:monokuroailink-lab/HAPPYWEEK7
```

完全な単体バイナリ配布にしたい場合は、将来的に `pkg` や `nexe` で `week7.exe` / `week7-macos` を作れます。ただし今の最小構成では、npm配布の方が安全で更新もしやすいです。

## Windows/macOS 対応

HAPPYWEEK7 は Node.js の標準ライブラリだけで動きます。

- Windows: `C:\Users\<name>\.claude\settings.json`
- macOS: `/Users/<name>/.claude/settings.json`

内部では `os.homedir()` と `path.join()` を使っているため、OSごとの差分は吸収されます。

Claude Code hook に登録するコマンドも、インストール時に使っている Node 実行ファイルと `week7.js` の絶対パスから生成します。

## Claude Code hooks

`week7 install` は `~/.claude/settings.json` に以下の hook を追加します。

- `Stop`
- `SubagentStop`
- `UserPromptSubmit`

`MessageDisplay` は触りません。漏れた本文がログ上に見えることを優先し、返答終了後に差し戻します。

## 保存場所

```text
~/.claude/week7/config.json
~/.claude/week7/state.json
~/.claude/week7/week7.log
~/.claude/week7/backups/
```

`install` / `uninstall` 時には `~/.claude/settings.json` のバックアップを保存します。

## 判定

以下のような unnamespaced な `invoke` / `parameter` タグを検知します。

```text
call
<invoke name="Bash">
<parameter name="command">echo ok</parameter>
</invoke>
```

### 誤検知を避ける仕組み（v0.2）

ツール自身の解説など、正規の文章でタグ例を書いても誤発火しないように、判定前に2段の絞り込みをかけます。

- **コードブロック除外**: ` ``` ` フェンスとインラインコード（`` `...` ``）の中身は判定対象から外します。ドキュメントやサンプルは安全です。
- **name属性の要求**: 開始タグが `name="..."` 属性を持つときだけ漏れと判定します。「invoke という単語」や属性なしの裸タグは通します。

本物の漏れは raw streaming で出るためフェンスに包まれず、必ず `name="..."` を伴います。この性質差を使って、AIに頼らず決定論のまま分離します。

なお `antml:` namespaced markup は通します。

```text
<antml:invoke name="Bash">
<antml:parameter name="command">echo ok</antml:parameter>
</antml:invoke>
```

## 設計メモ

`rewrite-once` は同じ `eventName/sessionId/messageHash` を一度だけ差し戻します。

これにより、Claude が1回目の差し戻し後も同じ内容を繰り返した場合、無限ループを避けるために2回目は通します。新しい漏れ、つまり本文ハッシュが変わった漏れは再び検知されます。
