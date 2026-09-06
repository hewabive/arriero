---
schema: 1
engine: sglang
primaryName: "--dsv4-prefill-backend"
title: "--dsv4-prefill-backend"
summary: "Выбирает BF16 или Q8KV8 sparse prefill для DeepSeek V4. Q8-путь ограничен SM90 и размерностью V 512."
group: exec.kernel
related:
  - --attention-backend
  - --dsa-prefill-backend
---

# --dsv4-prefill-backend

## Кратко

Выбирает BF16 или Q8KV8 sparse prefill для DeepSeek V4. Q8-путь ограничен SM90 и размерностью V 512.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
DeepSeek-V4 sparse prefill backend. 'auto' and 'flashmla_sparse' use the existing BF16 sparse prefill path; 'flashmla_sparse_q8' enables the Q8KV8 sparse prefill path.
```

## Паспорт аргумента

- Флаг: `--dsv4-prefill-backend`
- Группа: `exec.kernel`
- Тип: `str`
- Декларативный default: `"auto"`
- Объявление: `ServerArgs.dsv4_prefill_backend` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

DeepseekV4AttnBackend читает значение при построении backend и на sparse prefill. `flashmla_sparse_q8` включает Q8KV8 вместо BF16-деквантизации KV в рабочий буфер. При включении проверяются SM90 CUDA и `head_dim_v == 512`; несоответствие завершает старт с ValueError.

## Значения и формат

`auto` и `flashmla_sparse` сохраняют BF16-путь, `flashmla_sparse_q8` включает Q8. Отладочная переменная `SGLANG_DSV4_Q8KV8_PREFILL`, если задана, имеет приоритет над CLI: `1/true/yes/on` включают Q8, другие значения выключают.

## Когда использовать

Для сравнения sparse prefill на поддерживаемой DeepSeek V4 и Hopper. Оставляйте `auto`, если Q8-путь не проверен на вашей модели.

## Влияние на производительность и память

Меняет формат и обработку временного KV workspace и стоимость prefill. Это не общий переключатель dtype весов или decode KV-пула; сравнивайте TTFT и численные результаты.

## Взаимодействие с другими аргументами

Работает внутри `--attention-backend dsv4`. `--dsa-prefill-backend` относится к другому пути и не заменяет этот флаг.

## Типовые проблемы и диагностика

Ошибки `flashmla_sparse_q8 prefill requires SM90 CUDA GPUs` и `requires d_v=512` указывают точное ограничение. При неожиданном выборе проверьте отладочную переменную окружения.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4-Flash --attention-backend dsv4 --dsv4-prefill-backend flashmla_sparse_q8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py`
- `sglang/python/sglang/srt/layers/attention/dsv4/sparse_prefill_utils.py`
