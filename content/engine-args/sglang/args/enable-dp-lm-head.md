---
schema: 1
engine: sglang
primaryName: "--enable-dp-lm-head"
title: "--enable-dp-lm-head"
summary: Считает выходную проекцию словаря внутри attention-TP-группы вместо all-gather по всем DP-группам. Работает только при `--enable-dp-attention` и без него падает на старте.
group: parallel
related:
  - --enable-dp-attention
  - --dp-size
  - --tp-size
  - --moe-dense-tp-size
  - --moe-a2a-backend
  - --elastic-ep-backend
  - --max-ep-size
  - --speculative-algorithm
---

# --enable-dp-lm-head

## Кратко

С включенным DP-attention каждая DP-группа имеет свой батч, но выходная проекция `lm_head` по умолчанию остается общей на всю TP-группу — а значит перед ней нужен all-gather скрытых состояний со всех DP-групп. `--enable-dp-lm-head` переводит словарный параллелизм на attention-TP-группу: каждая DP-группа считает логиты только своих токенов. Это узкая оптимизация одного коллектива, а не смена топологии. Флаг жестко требует `--enable-dp-attention` и вместе с ним гасится, если `--dp-size` остался равным 1.

## Оригинальная справка

```text
Enable vocabulary parallel across the attention TP group to avoid all-gather across DP groups, optimizing performance under DP attention.
```

## Паспорт аргумента

- Флаги: `--enable-dp-lm-head`
- Группа: `parallel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует; парного `--no-…` нет
- Значение по умолчанию: `false`
- Эффективное значение: принудительно `False`, если `dp_size == 1` и `ep_join_mode != "scale"` (`_data_parallelism_defaults`); принудительно `True` при `--dwdp-size > 1` (`_handle_dwdp`). Проверка `_dp_lm_head_validation` требует, чтобы к моменту валидации `enable_dp_attention` был истинным. Поле помечено `resolvable=True`
- Где объявлен: `ServerArgs.enable_dp_lm_head`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_data_parallelism` → `_dp_lm_head_validation`) → построение модели (`LogitsProcessor`, головы конкретных архитектур) → каждый forward на шаге сэмплирования

## Что меняет в движке

Значение публикуется в `ParallelState` и читается в двух местах:

1. `layers/logits_processor.py`: `self.use_attn_tp_group = get_parallel().enable_dp_lm_head`. Когда истинно, редукция логитов идет по attention-TP-группе, а не по полной TP-группе, и all-gather скрытых состояний между DP-группами перед головой не нужен.
2. Головы конкретных архитектур получают тот же флаг как `use_attn_tp_group=…`. В checkout'е это делают, среди прочих, `deepseek_v2.py`, `qwen3_moe.py`, `kimi_k3.py`, `minimax_m3.py`, `bailing_moe.py`, `mimo_v2.py`, `step3p5.py`, `nemotron_h.py`, `sdar*.py`, `exaone_moe_mtp.py`, `qwen3_next_mtp.py`, `qwen3_5_text.py`. Модели, чья голова этот параметр не принимает, флагом не затрагиваются — эффект зависит от архитектуры.

Третий, менее очевидный эффект — в `utils/common.py:require_mlp_tp_gather`: там при включенном DP-attention ветка `elif not get_parallel().enable_dp_lm_head: return True` означает, что **без** этого флага MLP-вход всегда собирается через gather. Включение флага открывает дорогу более экономным веткам (в частности, сравнению `moe_dense_tp_size > tp_size // dp_size`).

Спекулятивное декодирование смотрит на флаг отдельно (`arg_groups/speculative_hook.py`) — draft-голова должна согласовываться с целевой.

## Значения и формат

- Флаг без аргумента. «Не задан» = логиты считаются по всей TP-группе с all-gather между DP-группами.
- Требует `--enable-dp-attention`; иначе `AssertionError: Please enable dp attention when setting enable_dp_lm_head.`
- Требует `--dp-size > 1` косвенно: при `dp_size == 1` оба флага сбрасываются вместе, и `assert` не сработает — флаг просто исчезнет.

## Когда использовать

- Всегда, когда включен DP-attention на MoE-модели из списка поддержанных архитектур и словарь большой (DeepSeek, Kimi, Qwen3-MoE): убирается коллектив на каждом шаге decode.
- Обязательно при elastic EP scale-up: `assert resolved.enable_dp_lm_head` с пояснением, что иначе выходная проекция зависела бы от TP-размера присоединяющейся группы.
- Не включайте без DP-attention — старт упадет.
- Не ждите эффекта на модели, чья голова не принимает `use_attn_tp_group`: флаг тогда влияет только через `require_mlp_tp_gather`.

## Влияние на производительность и память

- **Latency decode.** Основной эффект: минус один all-gather скрытых состояний на каждый шаг. Заметен тем сильнее, чем больше `dp_size` и чем меньше батч.
- **VRAM.** Веса `lm_head` при словарном параллелизме по attention-TP-группе распределяются иначе; при `attn_tp_size == 1` (`dp_size == tp_size`) каждая группа держит полную голову — на больших словарях это заметная добавка. Это обратная сторона экономии коллектива.
- **Throughput.** Прямого влияния на размер KV-пула и конкурентность нет.
- **Время старта.** Не меняет.

## Взаимодействие с другими аргументами

- `--enable-dp-attention`: обязательное условие; проверяется `assert`.
- `--dp-size`: при `1` оба флага сбрасываются.
- `--moe-dense-tp-size`: вместе определяют, какая ветка `require_mlp_tp_gather` сработает.
- `--moe-a2a-backend`: `none` и `flashinfer` в `require_mlp_tp_gather` дают `True` раньше, чем очередь дойдет до этого флага.
- `--elastic-ep-backend` + `--max-ep-size` (scale-up): требует включенного флага.
- `--dwdp-size`: включает флаг автоматически.
- `--speculative-algorithm`: draft-голова согласуется с этим флагом в `speculative_hook.py`.

## Типовые проблемы и диагностика

- `AssertionError: Please enable dp attention when setting enable_dp_lm_head.` — задан без `--enable-dp-attention`.
- `AssertionError: Elastic EP scale-up requires --enable-dp-lm-head so output projection does not depend on the joining group's TP size.` — забыт в elastic-конфигурации.
- Флаг задан, эффекта нет, ошибок тоже — вероятнее всего `--dp-size` равен 1 и оба DP-флага сброшены; проверьте отсутствие строки `DP attention is enabled. chunked prefill size is adjusted…` в логе.
- Рост потребления VRAM после включения при `dp_size == tp_size` — ожидаем: голова перестала быть общей.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tensor-parallel-size 4 --dp-size 4 --enable-dp-attention --enable-dp-lm-head --moe-dense-tp-size 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/models/qwen3_moe.py`
