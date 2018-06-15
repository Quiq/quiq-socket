// @flow

import qs from 'qs';

export const formatQueryParams = (url: string, params: ?Object): string => {
  if (url.includes('?')) {
    const splitUrl = url.split('?');
    return `${splitUrl[0]}?${qs.stringify(Object.assign({}, qs.parse(splitUrl[1]), params))}`;
  }

  if (params && Object.keys(params).length) {
    return `${url}?${qs.stringify(params)}`;
  } 
  
  return url;
};