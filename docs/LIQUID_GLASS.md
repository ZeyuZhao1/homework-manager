# 悬浮玻璃控件

本应用以 Web CSS 实现接近 Liquid Glass 的导航层视觉。原生平台的实时折射与环境光响应仍由 Apple 的系统渲染器提供；这里使用局部背景模糊、静态定向高光、边缘明暗和阴影，控制浏览器绘制开销。

## 官方依据

- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：玻璃主要用于内容上方的导航与功能层；文字较多的场景优先保证对比度，透明清晰材质更适合丰富媒体背景。
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)：返回导航位于前缘，主要操作与关闭操作处于易发现的独立位置；按功能组织控件，避免堆叠过多分组。
- [Meet Liquid Glass · WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/)：圆润的悬浮形态、光线与阴影共同表达控件与内容之间的层次关系。
- [Apple 官方设计介绍与案例图](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)：用于核对导航与内容层的关系。

## 应用方式

手机返回、添加与顶层关闭按钮采用 44–48 CSS 像素的圆形触控面；带长文字的返回和桌面新建操作采用胶囊。返回按钮只显示箭头，同时保留无障碍名称。详情顶部保持透明，只有独立控件显示玻璃；日历、作业卡片等内容保持稳定背景。

独立控件采用 18px 局部背景模糊，按压仅做短暂缩放；不添加 SVG 位移滤镜、WebGL、设备运动监听或逐帧光照。减少透明度或增加对比度时改用实色；减少动画时移除按压缩放。样式集中在 `src/floatingGlass.css`。
