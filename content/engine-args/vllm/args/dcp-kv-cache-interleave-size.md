---
schema: 1
engine: vllm
primaryName: "--dcp-kv-cache-interleave-size"
title: "--dcp-kv-cache-interleave-size"
summary: Предшественник `--cp-kv-cache-interleave-size`, оставленный до полной поддержки PCP. При значении больше единицы он перезаписывает новый флаг; в новых конфигурациях его задавать не нужно.
group: ParallelConfig
related:
  - --cp-kv-cache-interleave-size
  - --decode-context-parallel-size
  - --dcp-comm-backend
  - --block-size
  - --prefill-context-parallel-size
  - --attention-backend
---

# --dcp-kv-cache-interleave-size

## Кратко

Флаг задаёт ту же гранулярность чередования токенов KV-cache между DCP-рангами, что и `--cp-kv-cache-interleave-size`, но является **устаревшим**: справка прямо говорит, что он заменён новым флагом и будет удалён, когда prefill context parallel будет поддержан полностью.

Пока он жив, он имеет приоритет: при значении больше единицы движок перезаписывает им `cp_kv_cache_interleave_size` и пишет предупреждение. Механику раскладки смотрите в `--cp-kv-cache-interleave-size` — здесь только про сам переход.

## Оригинальная справка

```text
Interleave size of kv_cache storage while using DCP.
dcp_kv_cache_interleave_size has been replaced by cp_kv_cache_interleave_size,
and will be deprecated when PCP is fully supported.
```

## Паспорт аргумента

- Флаги: `--dcp-kv-cache-interleave-size`
- Группа argparse: `ParallelConfig`
- Тип значения: int (токены)
- Допустимые значения: не ограничены списком; фактические границы наследуются от `cp_kv_cache_interleave_size` — `≤ block_size` и делитель `block_size`
- Значение по умолчанию: `1` (объявлено обычным `int = 1`, без `Field`)
- Эффективное значение: при `--decode-context-parallel-size > 1` и значении `> 1`, отличном от `cp_kv_cache_interleave_size`, движок присваивает `cp_kv_cache_interleave_size = dcp_kv_cache_interleave_size` и пишет `cp_kv_cache_interleave_size is overridden by dcp_kv_cache_interleave_size. And dcp-kv-cache-interleave-size will be deprecated when PCP is fully supported.`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dcp_kv_cache_interleave_size`
- Этап применения: `VllmConfig.validate_block_size()` → раскладка KV-cache через `cp_kv_cache_interleave_size`

## Что меняет в движке

Поле почти целиком служит источником значения для `cp_kv_cache_interleave_size`: перезапись выполняется в `VllmConfig.validate_block_size()` и только при активном DCP. После неё проверка совместимости с размером блока (`interleave ≤ block_size`, `block_size % interleave == 0`) идёт уже по объединённому значению.

Одно место читает поле напрямую, минуя новый флаг: построитель метаданных FlashInfer (`vllm/v1/attention/backends/flashinfer.py`) берёт `self.dcp_kv_cache_interleave_size` из `parallel_config` и передаёт его в `get_dcp_local_seq_lens(...)`. При DCP это не расходится с новым флагом, потому что перезапись уже произошла; при `dcp_world_size == 1` поле там принудительно равно `1`.

## Значения и формат

- Целое `≥ 1`; `1` означает «не переопределять новый флаг».
- Любое значение `> 1` при активном DCP подменяет `--cp-kv-cache-interleave-size`, даже если тот задан явно и другим числом.
- Без `--decode-context-parallel-size > 1` значение не читается и не проверяется.
- Ограничения на соотношение с `--block-size` те же, что у нового флага, и проверяются после перезаписи.

## Когда использовать

- Практически никогда в новых конфигурациях: задавайте `--cp-kv-cache-interleave-size`.
- Единственный оправданный случай — перенос существующей команды запуска, в которой этот флаг уже стоит, без изменения поведения.
- Не задавайте оба флага одновременно: результат определяется устаревшим, и это источник путаницы.
- Поскольку флаг помечен на удаление, перед обновлением vLLM проверяйте его наличие в установленной версии через `vllm serve --help` — декларация в исходниках checkout'а не гарантирует, что он есть в вашей сборке.

## Влияние на производительность и память

Собственного влияния нет: всё сводится к тому, каким окажется `cp_kv_cache_interleave_size`. Эффекты по памяти, балансировке рангов и выравниванию рабочей области описаны в документе нового флага.

## Взаимодействие с другими аргументами

- `--cp-kv-cache-interleave-size`: перезаписывается этим флагом при значении больше единицы.
- `--decode-context-parallel-size`: без него перезапись и проверки не выполняются.
- `--block-size`: границы допустимых значений после перезаписи.
- `--prefill-context-parallel-size`: причина существования нового флага — PCP; после полной поддержки PCP этот флаг планируется убрать.
- `--attention-backend`: FlashInfer читает поле напрямую при построении метаданных.

## Типовые проблемы и диагностика

- **Симптом:** предупреждение `cp_kv_cache_interleave_size is overridden by dcp_kv_cache_interleave_size. And dcp-kv-cache-interleave-size will be deprecated when PCP is fully supported.` **Причина:** заданы оба флага. **Лечение:** оставить только `--cp-kv-cache-interleave-size`.
- **Симптом:** `AssertionError: Block_size(16) should be greater than or equal to and divisible by cp_kv_cache_interleave_size (32).` при том, что новый флаг не задавался. **Причина:** ограничение проверяется по значению, пришедшему из устаревшего флага. **Лечение:** согласовать значение с фактическим размером блока.
- **Симптом:** после обновления vLLM запуск падает на неизвестном аргументе. **Причина:** флаг удалён в установленной версии. **Проверка:** `vllm serve --help` в нужном окружении. **Лечение:** перейти на `--cp-kv-cache-interleave-size`.
- **Подтверждение принятого значения:** стартовая строка конфига содержит и `dcp_kv_cache_interleave_size=...`, и результирующий `cp_kv_cache_interleave_size=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --block-size 64 --dcp-kv-cache-interleave-size 64
```

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --block-size 64 --cp-kv-cache-interleave-size 64
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/vllm/v1/attention/backends/utils.py`
- `docs/CASE_PHANTOM_HELP_ARGS.md` (arriero)
