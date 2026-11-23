window.addEventListener('DOMContentLoaded', () => {
  window.ui = SwaggerUIBundle({url:'/api/openapi.json',dom_id:'#swagger-ui',deepLinking:true,validatorUrl:null});
});
