{
  NAME "Recover Briareus submissions"
  OPERATION Get-Jobs
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  ATTR keyword which-jobs all
  ATTR keyword requested-attributes job-id,job-name,job-printer-uri
  STATUS successful-ok
}
