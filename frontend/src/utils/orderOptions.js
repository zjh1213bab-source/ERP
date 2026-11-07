/** 预下单与业务下单共用颜色目录。 */
export const orderColorOptions=['纯色1',...Array.from({length:10},(_,i)=>'印花'+String(i+1).padStart(3,'0')),...Array.from({length:10},(_,i)=>'款式'+(i+1))];
