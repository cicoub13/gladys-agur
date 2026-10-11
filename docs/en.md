# Agur

Follow your [Agur](https://ael.agur.fr) water contract in Gladys: meter index,
consumption between two readings, average daily consumption, invoice amounts
and amount still due, with their history.

The integration also works with the other water utilities that use the same
customer website: **Grand Paris Sud** and **Eau de Paris**.

## Requirements

- An account on the customer website of your water utility, with at least one
  contract.
- Internet access on the machine running Gladys: the data is read on the
  website of the water utility.

## Configuration

Open the configuration screen of the integration and fill in:

| Field             | Description                                        |
| ----------------- | -------------------------------------------------- |
| **Water utility** | Agur (default), Grand Paris Sud or Eau de Paris.   |
| **Email**         | The email you log in with on the customer website. |
| **Password**      | The password of the customer website.              |

Then click **Test the connection**. On success, the button answers for example
`Connected to Agur: 1 contract(s) found.`; otherwise it shows one of the
messages described under "Troubleshooting" below.

## Devices

As soon as the connection works, each contract of the account shows up in the
**Discovery** tab of the integration, without a scan, named after the water
utility and the meter number (for example `Agur I21FA123456`). Create the ones
you want to follow. Their features:

| Feature                                | Unit | Description                                                                                                                                                                       |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meter index**                        | m³   | The meter index at the latest reading.                                                                                                                                            |
| **Consumption since previous reading** | m³   | Water used between the latest reading and the previous one, as billed.                                                                                                            |
| **Average daily consumption**          | L    | The average use per day over that same period, as computed by the water utility. Periods do not all last the same, so this is the figure to compare from one reading to the next. |
| **Invoice amount**                     | €    | The amount, taxes included, of the latest invoice (negative for a credit note).                                                                                                   |
| **Amount due**                         | €    | What is left to pay on the contract: positive when a sum is due, negative when the account is in your favour, 0 when it is settled.                                               |

The device also lists the contract number, the meter number and the delivery
address in its parameters.

### History

When the device is created, the integration sends Gladys **the whole history
available** on the customer website (readings and invoices), each at its real
date: the charts show the past from day one. A very long history is sent over
several minutes, to stay within the Gladys limit of 300 values per minute.

### Update frequency

The readings are the ones the water utility uses for **billing**: usually one
every six months or so, depending on your contract. The values shown are the
ones of the **latest reading**, not real-time consumption; they change with
each new reading or invoice. The integration reads the customer website every
6 hours, and 30 minutes after a failure.

## Troubleshooting

Error messages show in the connection status of the integration and under the
**Test the connection** button.

**"Enter the email and password of your water account in the
configuration."** Fill in both fields, then save.

**"Agur refused the email or password (…)."** The text between brackets is the
explanation of the water utility (in French). Check your credentials by logging
in on its website; if the website asks you to change your password, do so and
enter the new one in Gladys. To avoid getting your account locked, the
integration **suspends its updates** after a refusal: they resume when you save
the configuration or click **Test the connection**.

**"Agur did not answer in time", "Agur answered with an error (HTTP …)" or
"Agur sent an unexpected answer".** The website of the water utility is slow or
under maintenance. The integration tries again on its own; if it lasts several
days, check the integration logs and report the issue.

**"Agur cannot be reached."** Check the internet access of the machine running
Gladys.

**A contract is missing from the Discovery tab.** Check that it is visible on
the customer website with the same account, then click **Test the
connection**: the device list is refreshed right after.

## Privacy

The email and password are stored by Gladys (the password as a secret) and only
sent to the website of your water utility. The integration talks to nothing
else.

This integration is not affiliated with Agur, Grand Paris Sud or Eau de Paris.
It uses the interface of their customer website, which may change without
notice.
