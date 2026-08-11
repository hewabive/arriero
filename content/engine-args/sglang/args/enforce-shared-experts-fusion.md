---
schema: 1
engine: sglang
primaryName: "--enforce-shared-experts-fusion"
title: "--enforce-shared-experts-fusion"
summary: Заставляет модель слить shared expert в MoE-kernel даже там, где ворота архитектуры отключили бы fusion сами — прежде всего под DeepEP и на DeepSeek-V4. Автоматически включается вместе с `--enable-waterfill`.
group: exec.moe
related:
  - --disable-shared-experts-fusion
  - --enable-waterfill
  - --moe-a2a-backend
  - --moe-runner-backend
  - --ep-size
---

# --enforce-shared-experts-fusion

## Кратко

Слияние shared expert с маршрутизируемыми экспертами выключается по множеству причин: a2a-бэкенд класса DeepEP, экспертный параллелизм на NVIDIA, неподходящая квантизация, неподдерживаемая архитектура. Этот флаг снимает часть этих ограничений: ворота модели опрашивают его первым и, если он включен, немедленно возвращают «причины отключать нет». Что именно означает сам fusion, описано в документе `--disable-shared-experts-fusion`.

## Оригинальная справка

```text
Enforce shared experts fusion even when it would normally be disabled (e.g. under DeepEP). Mutually exclusive with --disable-shared-experts-fusion.
```

## Паспорт аргумента

- Флаги: `--enforce-shared-experts-fusion`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: принудительно ставится в `true` при `--enable-waterfill` (`_handle_a2a_moe`)
- Где объявлен: `ServerArgs.enforce_shared_experts_fusion`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подстановка от Waterfill) → загрузка модели, внутри `shared_experts_fusion_disable_reason`

## Что меняет в движке

Флаг читается только в воротах моделей, и по-разному в двух семействах:

- **DeepSeek-V2/V3 и наследники** (`sglang/python/sglang/srt/models/deepseek_v2.py`). Первая строка ворот: при включенном флаге сразу возвращается `None`, то есть **все** проверки пропускаются — SBO/TBO, DeepEP, архитектура checkpoint'а, число экспертов, compute capability, экспертный параллелизм, квантизация. Это очень грубый инструмент: он снимает и те ограничения, которые защищают от неверной загрузки весов (например, allow-list на `n_routed_experts` в 256 и 384, где 384 допустим только для Quark-MXFP4 checkpoint'а Kimi-K2.5 — обычный checkpoint хранит shared expert отдельно и в fused-раскладке загрузится неправильно, без ошибки).
- **DeepSeek-V4** (`sglang/python/sglang/srt/models/deepseek_v4.py`). Здесь логика обратная: без флага ворота всегда возвращают `Config does not support fused shared expert(s).`, то есть fusion по умолчанию выключен. С флагом дополнительно проверяется `n_shared_experts == 1`, иначе `ValueError: DeepSeek V4 shared-experts fusion expects exactly one shared expert, but got n_shared_experts=N.` Для V4 этот флаг — единственный способ включить fusion.

Заявленное в справке взаимное исключение с `--disable-shared-experts-fusion` в коде не проверяется: `install_shared_experts_fusion_decision` опрашивает ворота только если отключение не запрошено, поэтому при обоих флагах выигрывает отключение — без ошибки и без предупреждения.

## Значения и формат

- Флаг без значения. Отсутствие — решение принимают ворота модели по своим условиям.
- Наличие на семействе V3 — «слить, что бы ни говорили проверки».
- Наличие на V4 — «слить, если в checkpoint'е ровно один shared expert».
- На моделях без ворот `shared_experts_fusion_disable_reason` флаг не читается вовсе.

## Когда использовать

- DeepEP-развертка DeepSeek-V3/R1, где вы измерили, что fused-путь дает выигрыш, несмотря на дополнительный a2a-трафик shared expert.
- DeepSeek-V4, где fusion нужен как предпосылка Waterfill (в этом случае флаг ставится автоматически вместе с `--enable-waterfill`, и указывать его руками не нужно).
- Не включайте на checkpoint'е, которого нет в allow-list ворот: пропуск проверки не сделает раскладку весов правильной, ошибка будет тихой и проявится качеством ответов.
- Не используйте как «универсальный ускоритель»: на конфигурациях, где ворота отключают fusion по железу (низкая compute capability), принудительное включение приведет к падению ядра, а не к ускорению.

## Влияние на производительность и память

- Прямого расхода флаг не добавляет; он меняет геометрию MoE-слоя так же, как обычный fusion (`n_routed_experts + слоты shared`, topk на единицу больше).
- Под DeepEP shared expert начинает ездить через a2a-диспетчер: трафик dispatch/combine растет примерно на 1/topk, зато исчезает отдельный dense-проход. Что перевесит — зависит от размера батча и режима DeepEP, это надо измерять.
- На старте изменение решения о fusion меняет отображение имен весов, то есть влияет на путь загрузки, а не на ее длительность.

## Взаимодействие с другими аргументами

- `--disable-shared-experts-fusion`: формально взаимоисключающий; фактически при обоих флагах побеждает он.
- `--enable-waterfill`: включает этот флаг сам.
- `--moe-a2a-backend`: основной сценарий — снять отключение fusion под бэкендами класса DeepEP.
- `--moe-runner-backend`: FlashInfer CuteDSL/TRT-LLM раннеры выставляют `--disable-shared-experts-fusion`, и этот флаг их не переспорит.
- `--ep-size`: экспертный параллелизм на NVIDIA — одна из причин отключения, которую флаг снимает.

## Типовые проблемы и диагностика

- Ожидали fusion, но в логе снова `... Shared experts fusion optimization is disabled.` — где-то выставлен `--disable-shared-experts-fusion` (возможно, автоматически раннером); проверьте дамп `server_args=`.
- `ValueError: DeepSeek V4 shared-experts fusion expects exactly one shared expert, but got n_shared_experts=N.` — checkpoint V4 с другим числом shared-экспертов.
- Модель отвечает бессмыслицей после включения флага на нестандартном checkpoint'е — вы обошли allow-list; уберите флаг.
- Падение ядра MoE после включения на старой карте — снят чек на compute capability.
- Признак успешного fusion — отсутствие строки с причиной отключения плюс, при Waterfill, строка `Prepared N Waterfill TopK modules.`

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enforce-shared-experts-fusion
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V4-Flash --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode auto --enforce-shared-experts-fusion
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/models/deepseek_v4.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
