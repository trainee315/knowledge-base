# v0.0.4 运行与阅读

Node.js24+，npm ci后运行npm run dev，默认http://127.0.0.1:5183；页面与只读API共用端口。选择组织与体系或访问/#browse，按标签、关键词、体系、项目跟踪浏览。

正式构建预览：npm run build后运行node dist/cli/main.js preview start --json；preview status/stop查询与停止对应实例。数据目录可通过--data-dir指定；开发预览可用KB_DATA_DIR选择资料库。插件启停后重启对应预览。

标签可多选并切换任意/全部。关键词先搜索名称，再选具体词。体系先选实例，再选目录节点。项目记录显示阶段、版本、替代声明和历史原件版本，planned不表示已生效。选中文章后概览高亮，切换文章只保留一个选中项，刷新恢复阅读目标。

CLI组合查询沿用UTF8 JSON输入，例如输入文件内容为{"tags":["游戏架构","面向agent游戏架构"],"tagMatch":"all"}，再运行node dist/cli/main.js organize query --input query.json --json；也可使用--tag-match all覆盖输入值。

资源、元数据和本地备份保存在资料库，私人资料不提交源码仓库。
