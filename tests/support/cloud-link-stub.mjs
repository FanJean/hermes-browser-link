// 中文注释：原本地后台用例隔离新 Native 通道，真实云端授权由专属用例覆盖。
export class CloudLink {
 view(){return {state:'unavailable',online:false,paired:false,fullAccess:false};}
 modeForTask(){return null;}
 async connect(){return this.view();}
 async refresh(){}
 async act(){throw Error('此合成用例不调用云端');}
}
