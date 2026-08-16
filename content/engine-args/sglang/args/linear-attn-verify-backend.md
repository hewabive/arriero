---
schema: 1
engine: sglang
primaryName: "--linear-attn-verify-backend"
title: "--linear-attn-verify-backend"
summary: Ядро линейного внимания для спекулятивной сверки черновых токенов. Реально читается только KDA-диспетчером (Kimi Linear, Kimi K3); у GDN-моделей verify-ядро выбирается автоматически и этот флаг ими игнорируется.
group: exec.mamba
related:
  - --linear-attn-backend
  - --linear-attn-decode-backend
  - --linear-attn-prefill-backend
  - --mamba-ssm-dtype
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --enable-linear-replayssm-spec
  - --speculative-num-draft-tokens
---

# --linear-attn-verify-backend

## Кратко

При спекулятивном декодировании целевая модель проверяет сразу несколько черновых токенов, и линейному вниманию нужен отдельный режим — прогнать окно токенов через рекуррентность и корректно откатиться до принятого префикса. Ядро для этого режима задает `--linear-attn-verify-backend`. Важное ограничение области: значение читает только `KDAKernelDispatcher`. GDN-диспетчер конструируется вообще без параметра verify — он берет FlashInfer-ядро, если то уже создано для decode или prefill и умеет target-verify, иначе Triton. Так что на Qwen3-Next и других GDN-гибридах флаг влияет только через общее поле `verify` в логе, но не на выбор ядра.

## Оригинальная справка

```text
Override the kernel backend for linear attention speculative target-verify. If not set, follows the decode backend (flashinfer decode -> flashinfer verify, otherwise triton). KDA supports triton, nv_cutedsl, and flashinfer verify backends.
```

## Паспорт аргумента

- Флаги: `--linear-attn-verify-backend`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `triton`, `cutedsl`, `flashinfer`, `flashkda`, `nvidia_kda`, `ptx_kda`, `helion`, `nv_cutedsl` — это общий список linear-attn backend'ов **плюс** `nv_cutedsl`, который допустим только здесь. Фактически KDA-диспетчер принимает `triton`, `nv_cutedsl` и `flashinfer`; `helion`, попавший в список вместе с остальными фазами, verify-ядра не имеет и отвергается
- Значение по умолчанию: `null` — следует за decode: `flashinfer`, если decode `flashinfer`, иначе `triton`
- Эффективное значение: подстановка выполняется в `initialize_linear_attn_config`; `_handle_linear_attn_backend` дополнительно проверяет разрешенное значение на совместимость с типом состояния
- Где объявлен: `ServerArgs.linear_attn_verify_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка типа состояния) → создание backend'а внимания → каждый шаг target-verify

## Что меняет в движке

### Кто читает значение

`initialize_linear_attn_config` разрешает три роли и кладет их в общий словарь; `KDAKernelDispatcher` собирает из роли `verify` конкретное ядро:

- `triton` — фьюзнутое ядро, умеющее и цепочку, и дерево (через `retrieve_parent_token`); это эталон, против которого написаны тесты корректности KDA;
- `flashinfer` — `recurrent_kda`, только SM100 и только линейная цепочка; если decode уже на FlashInfer, переиспользуется тот же объект ядра;
- `nv_cutedsl` — фьюзнутая плотная сверка Kimi-K3/DSpARK; в текущем диспетчере объект verify-ядра для этого значения — `TritonKDAKernel` (выбор влияет на путь исполнения, а не на класс);
- любое незарегистрированное значение (`custom`) — `NotImplementedError: --linear-attn-verify-backend custom: no custom KDA verify kernel is registered yet.`
- прочее из списка — `ValueError: Unsupported KDA verify backend: …. KDA verify supports 'triton', 'nv_cutedsl', or 'flashinfer'.`

`GDNKernelDispatcher` получает на вход только `decode_backend` и `prefill_backend`. Его verify-ядро — `flashinfer_kernel`, если FlashInfer-ядро создано и `supports_target_verify` истинно, иначе `triton_kernel`.

### Проверка типа состояния

```text
--linear-attn-verify-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got …
```

Проверка применяется к разрешенному значению, то есть срабатывает и тогда, когда `flashinfer` пришел не из этого флага, а по наследованию от decode.

### Роль в ReplaySSM

При `--enable-linear-replayssm-spec` и не-статическом режиме ragged-verify (`SGLANG_RAGGED_VERIFY_MODE`) движок требует связку «семейство fold-every-commit (`DSPARK`/`DFLASH`) плюс verify-ядро, которое пишет кольцо» — то есть `triton` или `nv_cutedsl`. FlashInfer-ядро кольцо не пишет, и свернулось бы устаревшее содержимое, поэтому комбинация отвергается на старте.

## Значения и формат

- Значение вне списка отвергает argparse. Список здесь на один элемент длиннее, чем у остальных linear-attn флагов.
- Не задан — следование за decode; это осмысленный дефолт, менять его стоит только осознанно.
- `flashkda`, `nvidia_kda`, `ptx_kda`, `cutedsl`, `helion` формально принимаются argparse, но KDA-диспетчер их отвергает: у них нет verify-ядра. Для Helion это осознанно: при `--linear-attn-decode-backend helion` сверка по умолчанию уходит на эталонное Triton-ядро (резолюция «decode не flashinfer → verify triton»).
- Без спекулятивного декодирования значение не используется ни в одной семье.

## Когда использовать

- На KDA-моделях с алгоритмами DSpARK/DFLASH — когда нужна фьюзнутая плотная сверка: `nv_cutedsl`.
- На KDA-моделях, где decode уже на FlashInfer, но сверку хочется оставить на эталонном Triton-ядре (например, при отладке расхождений в принятых токенах): задать `triton` явно.
- Обязательно задавать `triton` или `nv_cutedsl` при `--enable-linear-replayssm-spec` вне статического ragged-режима.
- Не задавать на GDN-моделях: значение попадет в лог, но ядро выберется без него.
- Не задавать без спекуляции: это мертвая настройка.

## Влияние на производительность и память

- VRAM: verify-ядра работают с уже выделенными буферами спекуляции (`intermediate_ssm`, `intermediate_conv_window`) и своих пулов не заводят. Исключение — `--enable-linear-replayssm-spec`, который меняет саму схему буферов, а не только ядро.
- RAM хоста: не влияет.
- Время старта: FlashInfer-ядро компилируется JIT; при совпадении с decode переиспользуется уже созданный объект, то есть дополнительной компиляции нет.
- Latency: сверка выполняется раз на цикл спекуляции для всего окна черновых токенов; ее вклад тем заметнее, чем больше `--speculative-num-draft-tokens`.
- Корректность: `triton` — единственное ядро, поддерживающее древовидную сверку. При `--speculative-eagle-topk` больше 1 линейные цепочные ядра неприменимы.

## Взаимодействие с другими аргументами

- `--linear-attn-decode-backend`: источник значения по умолчанию.
- `--linear-attn-backend`: база, из которой берется decode, если тот не задан.
- `--mamba-ssm-dtype bfloat16`: обязателен для `flashinfer` на SM100+.
- `--speculative-algorithm`: `nv_cutedsl` имеет смысл в семействе DSpARK/DFLASH; при `--enable-linear-replayssm-spec` вне статического ragged-режима эти алгоритмы обязательны.
- `--speculative-eagle-topk`: значение больше 1 (дерево) требует Triton-сверки.
- `--enable-linear-replayssm-spec`: ограничивает выбор `triton`/`nv_cutedsl` в ragged-режимах.
- `--speculative-num-draft-tokens`: размер окна, которое обрабатывает verify-ядро.

## Типовые проблемы и диагностика

- `ValueError: Unsupported KDA verify backend: LinearAttnKernelBackend.CUTEDSL. KDA verify supports 'triton', 'nv_cutedsl', or 'flashinfer'.` — та же ошибка встречает и `helion`: verify-роли у него нет, несмотря на присутствие в списке argparse.
- `ValueError: --linear-attn-verify-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got 'float32'` — в том числе когда `flashinfer` унаследован от decode.
- `NotImplementedError: --linear-attn-verify-backend custom: no custom KDA verify kernel is registered yet.` — значение добавлено внешним пакетом, но ядра под него нет.
- `ValueError: --enable-linear-replayssm-spec with SGLANG_RAGGED_VERIFY_MODE=… requires the KDA fold-every-commit family (DSPARK/DFLASH) and a ring-writing verify kernel (--linear-attn-verify-backend triton or nv_cutedsl) …`
- Задали значение на Qwen3-Next и не увидели разницы — GDN-диспетчер его не читает.
- Что смотреть в логе: `Linear attention kernel backend: decode=…, prefill=…, verify=…` (разрешенные имена) и следом `KDA kernel dispatcher: decode=…, verify=…, extend=…` — там уже классы реальных ядер.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --linear-attn-verify-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --linear-attn-decode-backend flashinfer --linear-attn-verify-backend flashinfer --mamba-ssm-dtype bfloat16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/linear/utils.py`
- `sglang/python/sglang/srt/layers/attention/linear/kda_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- upstream PR: sgl-project/sglang#32593 ([Kernel] Enable Helion backend for Kimi Delta-Attention)
