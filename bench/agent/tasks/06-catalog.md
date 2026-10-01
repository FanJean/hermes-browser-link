# 基准任务：同站多页采集

访问 http://www.bench.localhost:{{PORT}}/catalog ，打开目录列出的 8 个详情页。每页的字段会延迟加载。按目录顺序提取编号、名称、分类、价格，写入 UTF-8 CSV 文件 `{{OUTPUT}}`，表头为 `id,name,category,price`。完成后报告行数和文件路径。

只处理这个网站的这一项任务。
