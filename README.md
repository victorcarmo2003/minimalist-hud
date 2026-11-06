# minimalist-hud

Statusline minimalista para o Claude Code, desenhada como uma caixa:

```
╭──────────────── ~/projeto ────────────────╮
│ [Sonnet 5.5 ◑ high]   [▤ Context 16%]   ◷ 2h [5h ████░░░ 55%] │
│ [CAVEMAN:ULTRA]                         ◷ 3d [7d ██████░ 88%] │
╰───────────────────────────────────────────╯
```

Mostra o diretório atual, o modelo com o nível de effort, o uso do contexto e os limites de uso de 5 horas (`5h`) e 7 dias (`7d`), com o tempo restante até o reset. As colunas da direita somem sozinhas quando o terminal é estreito.

## Requisitos

- Node.js 18 ou superior no `PATH`.
- Um terminal com cores truecolor e uma fonte que tenha os glifos `◔ ◷ ▤` (e os de caixa `╭ ╮ │ ╰ ╯ █ ░`). Se algum aparecer como quadrado, troque a fonte do terminal.

## Instalação

Dentro do Claude Code, rode os três comandos:

```
/plugin marketplace add victorcarmo2003/minimalist-hud
/plugin install minimalist-hud@minimalist-hud
/minimalist-hud:install
```

O último comando copia a statusline para `<pasta de config>/plugins/minimalist-hud/statusline.mjs` e grava o `statusLine` no seu `settings.json`. Antes de escrever ele cria um backup `settings.json.minimalist-hud.<data>.bak` ao lado do arquivo. Se você já tiver outra statusline, ele mostra o comando atual e só substitui com a sua confirmação; a configuração antiga fica guardada em `plugins/minimalist-hud/previous-statusline.json`.

Se a barra não aparecer logo em seguida, reinicie o Claude Code.

## Atualizar

Depois de atualizar o plugin, rode `/minimalist-hud:install` de novo. A statusline em uso é uma cópia, então ela só muda quando você reinstala.

## Desinstalar

Rode **antes** de remover o plugin:

```
/minimalist-hud:install uninstall
```

Isso restaura a statusline anterior (ou remove a chave `statusLine`, se não havia outra) e apaga a cópia. Depois disso, remova o plugin normalmente.

Restauração manual: se o plugin já foi removido, abra `plugins/minimalist-hud/previous-statusline.json` dentro da sua pasta de config do Claude Code (por padrão `~/.claude`), copie o conteúdo para a chave `statusLine` do `settings.json` e apague a pasta `plugins/minimalist-hud`. Sem esse arquivo, basta apagar a chave `statusLine`.

## Badges extras

Além do badge do plugin caveman (que só aparece quando ele está ativo), você pode mostrar o conteúdo de arquivos de texto. Crie `statusline-badges.json` na sua pasta de config (por padrão `~/.claude/statusline-badges.json`):

```json
{
  "badges": [
    { "file": "~/.claude/.meu-badge", "format": "[MEU:{}]", "color": 213 }
  ]
}
```

- `file`: arquivo cuja primeira linha vira o `{}` do `format`. Um `~` no início vira o seu diretório home. Se o arquivo não existir ou estiver vazio, o badge some. Só são aceitos arquivos comuns pequenos (não links simbólicos); do texto ficam apenas letras, números, `:`, `.`, `-` e espaço.
- `format`: opcional, o padrão é `[{}]`.
- `color`: opcional, um número da paleta de 256 cores ou parâmetros SGR, como `"38;2;255;0;128"`.

## Quando aparecem os limites 5h e 7d

Os limites `5h` e `7d` só aparecem para assinantes e somente depois da primeira resposta da sessão, porque o Claude Code só recebe esses dados a partir daí.

## Licença

MIT. Veja [LICENSE](LICENSE).
