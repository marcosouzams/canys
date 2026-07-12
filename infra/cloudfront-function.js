// Função CloudFront (viewer-request) da distribuição EM5PUFX8CLXNE.
// 1. Redireciona www.canys.com.br -> canys.com.br (301).
// 2. Reescreve URLs de diretório para o index.html correspondente
//    (/mail/ e /mail -> /mail/index.html), necessário porque a origem é
//    S3 REST (OAC), que não resolve index de subdiretório sozinha.
function handler(event) {
    var request = event.request;
    var host = (request.headers.host && request.headers.host.value) || '';

    if (host === 'www.canys.com.br') {
        var qs = '';
        if (request.querystring) {
            var parts = [];
            for (var key in request.querystring) {
                var v = request.querystring[key];
                if (v.value === '') {
                    parts.push(encodeURIComponent(key));
                } else {
                    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v.value));
                }
            }
            if (parts.length > 0) {
                qs = '?' + parts.join('&');
            }
        }
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': { value: 'https://canys.com.br' + request.uri + qs }
            }
        };
    }

    var uri = request.uri;
    if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
    } else if (!uri.includes('.')) {
        request.uri = uri + '/index.html';
    }

    return request;
}
