---
schema: 1
engine: sglang
primaryName: "--enable-gdn-replayssm-spec"
title: "--enable-gdn-replayssm-spec"
summary: Устаревшее имя `--enable-linear-replayssm-spec` — режим проверки спекулятивных токенов для линейного внимания через переигрывание сырых входов вместо снимков полного состояния. Переименован, потому что механизм перестал быть специфичным для GDN.
group: null
related:
  - --enable-linear-replayssm-spec
  - --enable-linear-replayssm
  - --linear-replayssm-cache-len
  - --linear-attn-decode-backend
  - --linear-attn-verify-backend
  - --speculative-eagle-topk
  - --speculative-algorithm
  - --mamba-ssm-dtype
  - --mamba-radix-cache-strategy
  - --disaggregation-mode
---

# --enable-gdn-replayssm-spec

## Кратко

При спекулятивном декодировании на моделях с линейным вниманием проверка черновика требует уметь откатить рекуррентное состояние. Классический способ — снимать полное состояние перед каждым черновым шагом; ReplaySSM вместо этого хранит окно сырых входов на слот и на коммите переигрывает принятый префикс в fp32-контрольную точку. Флаг устарел: механизм изначально был написан под GDN (gated delta net), затем распространен на KDA, и имя сменилось на `--enable-linear-replayssm-spec`.

## Оригинальная справка

```text
[Deprecated] Use --enable-linear-replayssm-spec instead.
```

## Паспорт аргумента

- Флаги: `--enable-gdn-replayssm-spec`
- Группа: `null` — устаревший флаг объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `exec.mamba`, где живет актуальный флаг
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False`
- Эффективное значение: кладет `True` в `enable_linear_replayssm_spec`; дальше значение неотличимо от заданного актуальным флагом
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `enable_linear_replayssm_spec`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--enable-linear-replayssm-spec`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_linear_attn_backend` (набор проверок и подстановка `--mamba-ssm-dtype float32`) → verify/commit на спекулятивном пути

## Что меняет в движке

### Предупреждение и трансляция

```text
'--enable-gdn-replayssm-spec' is deprecated and will be removed in a future release. Use '--enable-linear-replayssm-spec' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Ограничения, которые проверяются на старте

`_handle_linear_attn_backend` собирает вокруг этого поля плотный набор условий; каждое из них — отказ на старте, а не деградация:

- `--speculative-eagle-topk` должен быть `None` или `1`: ядро проверки использует строго нижнюю причинную маску и для древовидного EAGLE-verify неверно (`the chunked verify kernel uses a strictly-lower causal mask and is invalid for EAGLE tree verify`);
- `--linear-attn-decode-backend` должен быть `triton` или `flashinfer`;
- при `SGLANG_RAGGED_VERIFY_MODE`, отличном от `static`, требуется семейство алгоритмов `DSPARK`/`DFLASH` и verify-backend `triton` или `nv_cutedsl`;
- запрещен на PD-prefill-сервере: спекулятивной проверки там не бывает;
- взаимно исключающий с `--enable-linear-replayssm` (они делят кольцо, но двигают курсор по разным протоколам).

Плюс одна автоматическая подстановка: при незаданном `--mamba-ssm-dtype` он ставится в `float32` с информационным сообщением, потому что замкнутый цикл переигрывания дает бит-в-бит совпадение с рекуррентной базой только в fp32. Если dtype задан другим, печатается предупреждение о возможном дрейфе на длинных последовательностях.

## Значения и формат

- Булев флаг без значения.
- Работает только на гибридных моделях с линейным вниманием (GDN или KDA) и только при линейной цепочке черновика.
- GDN подбирает длину окна по максимуму черновика; KDA использует кольцо длиной `--linear-replayssm-cache-len`.
- В YAML через `--config` ключ `enable-linear-replayssm-spec` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`.

## Когда использовать

- Не использовать: пишите `--enable-linear-replayssm-spec`.
- Сам режим (под новым именем) выбирают ради памяти и скорости проверки: окно сырых входов на слот дешевле, чем полный снимок состояния на каждый черновой шаг.
- Не включать вместе с `--enable-linear-replayssm` и не пытаться применять к древовидному EAGLE — оба случая отвергаются на старте.
- Не менять `--mamba-ssm-dtype` вручную без измерения точности: fp32 здесь не перестраховка, а условие бит-в-бит эквивалентности.

## Влияние на производительность и память

- VRAM: вместо полного снимка состояния на каждый черновой шаг хранится окно сырых входов на слот; величина зависит от модели и от `--linear-replayssm-cache-len` для KDA.
- Пропускная способность: выигрыш на спекулятивном пути за счет более дешевого verify/commit.
- Время старта: не меняет.
- Точность: при fp32-состоянии эквивалентно рекуррентной базе; при другом dtype возможен дрейф, о чем движок предупреждает.

## Взаимодействие с другими аргументами

- `--enable-linear-replayssm-spec`: актуальное имя того же поля.
- `--enable-linear-replayssm`: взаимно исключающий режим (переигрывание на каждый decode-forward, а не на коммит проверки).
- `--linear-replayssm-cache-len`: длина кольца для KDA.
- `--speculative-eagle-topk`: обязан быть `None` или `1`.
- `--speculative-algorithm`: при не-статическом ragged-verify требуются `DSPARK` или `DFLASH`.
- `--linear-attn-decode-backend` / `--linear-attn-verify-backend`: допустимые backend'ы перечислены выше.
- `--mamba-ssm-dtype`: подставляется в `float32` при незаданном значении.
- `--mamba-radix-cache-strategy`: соседняя настройка того же семейства; у `--enable-linear-replayssm` есть жесткое требование `no_buffer`, у spec-варианта такого требования нет.
- `--disaggregation-mode prefill`: запрещен.

## Типовые проблемы и диагностика

- `'--enable-gdn-replayssm-spec' is deprecated …` — замените на `--enable-linear-replayssm-spec`.
- `ValueError: --enable-linear-replayssm-spec requires a linear draft chain (--speculative-eagle-topk in {None, 1}); …` — древовидный EAGLE-verify не поддерживается.
- `ValueError: --enable-linear-replayssm-spec requires the triton or flashinfer linear-attn decode backend, got …`
- `ValueError: --enable-linear-replayssm-spec is not supported on a PD prefill server: …`
- `ValueError: --enable-linear-replayssm-spec and --enable-linear-replayssm are mutually exclusive: …`
- Информационная строка `--enable-linear-replayssm-spec: setting --mamba-ssm-dtype float32 …` — нормальная автоматическая подстановка.
- Что смотреть: `enable_linear_replayssm_spec=` и `mamba_ssm_dtype=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B --speculative-algorithm NEXTN --speculative-num-steps 3 --speculative-eagle-topk 1 --enable-linear-replayssm-spec
```

С явным backend'ом линейного внимания:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B --speculative-algorithm NEXTN --speculative-eagle-topk 1 --enable-linear-replayssm-spec --linear-attn-decode-backend triton --linear-attn-verify-backend triton
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
