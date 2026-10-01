# 基准任务：表格采集

只访问 http://www.bench.localhost:{{PORT}}/data-table 。采集五页全部 250 行，按页面顺序写入 `{{OUTPUT}}`，UTF-8 CSV，首行为 `keyword,volume,KD,URL`。每一行四列，不要漏行或重复。完成后报告行数和文件路径。

只处理这个网站的这一项任务。
