# 基准任务：两站来回核对

完成三轮核对。每轮先到 http://www.bench.localhost:{{PORT}}/data-table 读取对应轮次的跨站核对值，再到 http://tools.localhost:{{PORT}}/query 输入该值并读取结果，随后回到数据表开始下一轮。按轮次把结果写入 UTF-8 JSON 文件 `{{OUTPUT}}`，格式为对象数组，每个对象含 `round`（数字）、`value`、`result`。

只处理这两个本地网站的这一项任务。
