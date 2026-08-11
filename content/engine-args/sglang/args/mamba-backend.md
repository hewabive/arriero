---
schema: 1
engine: sglang
primaryName: "--mamba-backend"
title: "--mamba-backend"
summary: Выбирает реализацию шага `selective_state_update` для mamba2-моделей (NemotronH, FalconH1, GraniteMoeHybrid). На GDN/KDA-гибридах не читается вовсе — там за ядра отвечает `--linear-attn-backend`.
group: exec.mamba
related:
  - --linear-attn-backend
  - --mamba-ssm-dtype
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-cache-philox-rounds
  - --enable-page-major-kv-layout
  - --speculative-eagle-topk
  - --max-mamba-cache-size
---

# --mamba-backend

## Кратко

Аргумент выбирает, чьим ядром считается шаг обновления SSM-состояния (`selective_state_update`) в декоде mamba2-слоев. Область действия узкая: только модели, чьи слои построены на `MambaMixer2` — NemotronH, FalconH1, GraniteMoeHybrid и производные от них VL-сборки. Для гибридов на gated delta net (Qwen3-Next, Qwen3.5, JetNemotron) и на KDA (Kimi Linear, Kimi K3) этот флаг не значит ничего: у них своя тройка `--linear-attn-backend` / `--linear-attn-prefill-backend` / `--linear-attn-decode-backend`. Значение `flashinfer` дает доступ к стохастическому округлению fp16-состояний на SM90, но запрещает древовидную верификацию EAGLE.

## Оригинальная справка

```text
Choose the kernel backend for Mamba SSM operations. Default is 'triton'. Options: 'triton' (default), 'flashinfer' (requires FlashInfer with Mamba support).
```

## Паспорт аргумента

- Флаги: `--mamba-backend`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `triton`, `flashinfer` (константа `MAMBA_BACKEND_CHOICES` в `server_args.py`; расширения извне для нее не предусмотрено, в отличие от списка linear-attn backend'ов)
- Значение по умолчанию: `triton`
- Эффективное значение: совпадает с заданным. Автоподбора нет; движок только проверяет выполнимость выбора в `_handle_mamba_backend`
- Где объявлен: `ServerArgs.mamba_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_mamba_backend` — проверка доступности FlashInfer) → инициализация scheduler'а (`initialize_mamba_selective_state_update_backend`) → каждый decode-forward mamba2-слоя

## Что меняет в движке

Значение попадает в реестр `_BACKEND_REGISTRY` файла `sglang/python/sglang/kernels/ops/mamba/triton_ops/ssu_dispatch.py`, и `Scheduler.__init__` создает из него глобальный объект backend'а. Дальше `MambaMixer2.forward_decode` (`sglang/python/sglang/srt/layers/attention/mamba/mamba.py`) вызывает его вместо прямого обращения к Triton-ядру.

Различия между двумя реализациями, помимо самих ядер:

- **Древовидная верификация.** `FlashInferSSUBackend` отвергает непустой `retrieve_parent_token` явной ошибкой `FlashInfer backend does not support retrieve_parent_token. Use --mamba-backend triton for EAGLE tree attention.` Это значит, что со спекуляцией EAGLE при `--speculative-eagle-topk` больше 1 работает только `triton`.
- **Стохастическое округление.** Раунды Philox у Triton берутся из `--mamba-cache-philox-rounds` как есть (`0` = дефолт Triton), у FlashInfer `0` превращается в 10, и дополнительно на каждый вызов генерируется `rand_seed` через `torch.randint`.
- **Требование к железу для округления.** `--enable-mamba-cache-stochastic-rounding` на `triton` требует SM100 (ядро использует PTX-инструкцию `cvt.rs.f16x2.f32`); на SM90 движок сам предлагает в тексте ошибки перейти на `--mamba-backend flashinfer`.

Проверка доступности выполняется на старте, до загрузки весов: при `flashinfer` движок пытается `import flashinfer.mamba` и либо пишет `Successfully imported FlashInfer mamba module`, либо падает с `ValueError: FlashInfer mamba module not available, please check the FlashInfer installation.`

## Значения и формат

- Значение вне списка отвергает argparse (`invalid choice`).
- `triton` — единственный вариант, у которого нет внешних зависимостей: ядро едет вместе с SGLang.
- `flashinfer` требует не просто установленного FlashInfer, а сборки с модулем `flashinfer.mamba`. Проверить на своей установке: `python -c "import flashinfer.mamba"`.
- `--enable-page-major-kv-layout` жестко требует `triton`: ассерт `--enable-page-major-kv-layout requires the Triton Mamba kernels for the strided conv/SSM state; got '<значение>'. Pass --mamba-backend triton.`
- На не-mamba2-модели значение принимается, инициализация backend'а происходит, но ни один слой его не вызывает.

## Когда использовать

- Оставить `triton`, если модель обслуживается со спекуляцией EAGLE с деревом (`--speculative-eagle-topk` > 1) или включен page-major-раскладка KV.
- Переключить на `flashinfer`, когда нужно стохастическое округление fp16-состояний на карте старше SM100: это единственный поддерживаемый там путь.
- Сравнивать бэкенды на своей нагрузке имеет смысл только для mamba2-моделей и только по времени decode-шага — на prefill выбор не влияет (там работает chunked-ядро сканирования, а не `selective_state_update`).
- Не трогать на Qwen3-Next и подобных: там нужен `--linear-attn-decode-backend`.

## Влияние на производительность и память

- VRAM: не меняет. Размер пула состояний определяется `--max-mamba-cache-size` / `--mamba-full-memory-ratio` и `--mamba-ssm-dtype`, а не выбором ядра.
- RAM хоста: не влияет.
- Время старта: `flashinfer` добавляет импорт своего модуля (и, при первом обращении, JIT-компиляцию ядра), `triton` — компиляцию Triton-ядра при первом decode-шаге.
- Latency decode: это и есть основной эффект — на mamba2-модели шаг обновления состояния выполняется каждым слоем каждый токен.
- Throughput: пропорционально latency decode; на prefill разницы нет.

## Взаимодействие с другими аргументами

- `--linear-attn-backend` и его per-phase варианты: параллельная, непересекающаяся настройка для GDN/KDA. Ни один из этих флагов не влияет на другой.
- `--enable-mamba-cache-stochastic-rounding`: `triton` требует SM100, `flashinfer` — модуля `flashinfer.mamba` и `--mamba-ssm-dtype float16`.
- `--mamba-cache-philox-rounds`: значение `0` трактуется двумя backend'ами по-разному (см. выше).
- `--speculative-eagle-topk` > 1: несовместим с `flashinfer` (ошибка при первом же верифицирующем forward'е).
- `--enable-page-major-kv-layout`: требует `triton`.
- `--mamba-ssm-dtype`: определяет dtype состояния, с которым работает выбранное ядро.

## Типовые проблемы и диагностика

- `ValueError: FlashInfer mamba module not available, please check the FlashInfer installation.` на старте — FlashInfer либо не установлен, либо собран без mamba-модуля. Вернитесь на `triton` или переустановите FlashInfer.
- `ValueError: FlashInfer backend does not support retrieve_parent_token. Use --mamba-backend triton for EAGLE tree attention.` — включена древовидная спекуляция. Либо `--speculative-eagle-topk 1`, либо `--mamba-backend triton`.
- `ValueError: Stochastic rounding for the Mamba SSM cache with --mamba-backend triton requires SM100 with CUDA >= 12.8 …` — карта старше Blackwell. Переходите на `flashinfer` или выключайте округление.
- `AssertionError: --enable-page-major-kv-layout requires the Triton Mamba kernels …`
- Что смотреть в логе: `Successfully imported FlashInfer mamba module` (только для `flashinfer`) и принятое значение `mamba_backend=` в итоговом дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-backend flashinfer --mamba-ssm-dtype float16 --enable-mamba-cache-stochastic-rounding
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/ssu_dispatch.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/mamba_ssm.py`
- `sglang/python/sglang/srt/layers/attention/mamba/mamba.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/configs/hybrid_arch.py`
