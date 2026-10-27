{
  NAME "Recover Briareus submissions"
  OPERATION Get-Jobs
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR language attributes-natural-language en
  ATTR uri printer-uri $uri
  # Default CUPS policy hides job names from anonymous requests; lp submitted as this user.
  ATTR name requesting-user-name $user
  ATTR keyword which-jobs all
  ATTR keyword requested-attributes job-id,job-name,job-printer-uri
  STATUS successful-ok
}
